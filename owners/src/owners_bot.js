/**
 * Copyright 2019 The AMP HTML Authors.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *      http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS-IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

const sleep = require('sleep-promise');
const {OwnersCheck} = require('./ownership/owners_check');
const {OwnersParser} = require('./ownership/parser');
const OwnersTree = require('./ownership/tree');
const {OwnersNotifier} = require('./notifier');

const GITHUB_CHECKRUN_DELAY = 2000;
const GITHUB_GET_MEMBERS_DELAY = 1000;
const OWNERS_CHECKRUN_NAME = 'owners-check';

/**
 * Bot to run the owners check and create/update the GitHub check-run.
 */
class OwnersBot {
  /**
   * Constructor.
   *
   * @param {!Repository} repo local copy of the repository.
   */
  constructor(repo) {
    this.repo = repo;
    this.teams = {};
    this.parser = new OwnersParser(this.repo, this.teams);
    this.treeParse = {errors: [], result: new OwnersTree()};

    // Defined as a property, to allow overriding in tests.
    this.GITHUB_CHECKRUN_DELAY = GITHUB_CHECKRUN_DELAY;
    this.GITHUB_GET_MEMBERS_DELAY = GITHUB_GET_MEMBERS_DELAY;
  }

  /**
   * Initialize the bot's list of teams.
   *
   * Also initializes each team's member list, spaced out to avoid hitting rate
   * limits. This is so that the member lists of many teams do not need to be
   * requested all at once when parsing the owners tree.
   *
   * @param {!GitHub} github GitHub API interface.
   */
  async initTeams(github) {
    const teamList = await github.getTeams();
    for (const team of teamList) {
      await this.syncTeam(team, github);
      await sleep(this.GITHUB_GET_MEMBERS_DELAY);
    }
  }

  /**
   * Fetch or update a team's members.
   *
   * @param {!Team} team GitHub Team to update.
   * @param {!GitHub} github GitHub API interface.
   */
  async syncTeam(team, github) {
    await team.fetchMembers(github);
    this.teams[team.toString()] = team;
  }

  /**
   * Update the owners tree.
   *
   * @param {Logger} logger logging interface
   */
  async refreshTree(logger = console) {
    logger.info('Refreshing owners tree');

    await this.repo.sync();
    await this.reparseTree(logger);
  }

  /**
   * Update the owners tree.
   *
   * @param {Logger} logger logging interface
   */
  async reparseTree(logger = console) {
    logger.info('Re-parsing owners tree');

    this.treeParse = await this.parser.parseOwnersTree();
    this.treeParse.errors.forEach(logger.warn, logger);
  }

  /**
   * Fetch and initialize key data for running checks on PR.
   *
   * @param {!GitHub} github GitHub API interface.
   * @param {!PullRequest} pr pull request to initialize data for.
   * @return {{
   *     reviewers: !ReviewerApprovalMap,
   *     changedFiles: !Array<string>,
   * }} key structures needed to check PR ownership.
   */
  async initPr(github, pr) {
    const changedFiles = await github.listFiles(pr.number);
    const reviewers = await this._getCurrentReviewers(github, pr);
    const pendingReviewers = await github.getReviewRequests(pr.number);
    pendingReviewers.forEach(reviewer => {
      reviewers[reviewer] = false;
    });

    return {changedFiles, reviewers};
  }

  /**
   * Runs the steps to create or update an owners-bot check-run on a GitHub Pull
   * Request.
   *
   * @param {!GitHub} github GitHub API interface.
   * @param {!PullRequest} pr pull request to run owners check on.
   * @param {?boolean} requestOwners request reviews from owners.
   */
  async runOwnersCheck(github, pr, requestOwners = false) {
    if (!pr.isOpen) {
      return;
    }

    const {changedFiles, reviewers} = await this.initPr(github, pr);
    const tree = this.treeParse.result;

    const checkRunIdMap = await github.getCheckRunIds(pr.headSha);
    const checkRunId = checkRunIdMap[OWNERS_CHECKRUN_NAME];
    const ownersCheck = new OwnersCheck(tree, changedFiles, reviewers).run();

    if (checkRunId) {
      await github.updateCheckRun(checkRunId, ownersCheck.checkRun);
    } else {
      // We need to add a delay on the PR creation and check creation since
      // GitHub might not be ready.
      // TODO(rcebulko): Verify this is still needed.
      await sleep(this.GITHUB_CHECKRUN_DELAY);
      await github.createCheckRun(pr.headSha, ownersCheck.checkRun);
    }

    const suggestedReviewers = requestOwners ? ownersCheck.reviewers : [];
    await new OwnersNotifier(pr, reviewers, tree, changedFiles).notify(
      github,
      suggestedReviewers
    );
  }

  /**
   * Runs the steps to create or update an owners-bot check-run on a GitHub Pull
   * Request.
   *
   * @param {!GitHub} github GitHub API interface.
   * @param {number} prNumber pull request number.
   */
  async runOwnersCheckOnPrNumber(github, prNumber) {
    const pr = await github.getPullRequest(prNumber);
    await this.runOwnersCheck(github, pr);
  }

  /**
   * Identifies all reviewers and whether their latest reviews are approvals.
   *
   * Also includes the author, unless the author has explicitly left a blocking
   * review.
   *
   * @private
   * @param {!GitHub} github GitHub API interface.
   * @param {!PullRequest} pr pull request to fetch approvers for.
   * @return {!ReviewerApprovalMap} map of reviewer approval statuses.
   */
  async _getCurrentReviewers(github, pr) {
    const reviews = await github.getReviews(pr.number);
    // Sort by the latest submitted_at date to get the latest review.
    const sortedReviews = reviews.sort((a, b) => a.submittedAt - b.submittedAt);
    const approvals = {};
    sortedReviews.forEach(review => {
      // Only treat comments as rejecting reviews if they do not follow an
      // existing approval or rejection.
      if (approvals[review.reviewer] === undefined || !review.isComment) {
        approvals[review.reviewer] = review.isApproved;
      }
    });
    // The author of a PR implicitly gives approval over files they own.
    approvals[pr.author] = true;

    return approvals;
  }
}

module.exports = {OwnersBot};
