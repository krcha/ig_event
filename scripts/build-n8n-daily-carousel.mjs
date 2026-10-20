import { readFileSync, writeFileSync } from 'node:fs';
import { publishEventZekaCarousel } from '../ops/n8n/publish-daily-carousel.mjs';
import { fetchEventZekaPublicationContext, rememberEventZekaSelection } from '../ops/n8n/social-publication-history.mjs';
import { assertSocialPublicationResult } from '../ops/n8n/social-publication-result.mjs';

const resultName = 'Verify Publication Result';
const resultCode = `${assertSocialPublicationResult.toString()}\n\nreturn assertSocialPublicationResult($input.all());`;

const path = new URL('../ops/n8n/event-zeka-daily-instagram-carousel.json', import.meta.url);
const workflows = JSON.parse(readFileSync(path, 'utf8'));
const workflow = workflows.find(candidate => candidate.id === 'EzekaDailyIg001');
if (!workflow) throw new Error('Daily Event Zeka workflow is missing.');
const node = workflow.nodes.find(candidate => candidate.id === 'generate-and-publish');
node.parameters.jsCode = `${publishEventZekaCarousel.toString()}\n\n${fetchEventZekaPublicationContext.toString()}\n\n${rememberEventZekaSelection.toString()}\n\nreturn await publishEventZekaCarousel({\n  env: $env,\n  httpRequest: this.helpers.httpRequest.bind(this.helpers),\n  getStaticData: () => $getWorkflowStaticData('global'),\n  forceDryRun: $execution.mode === 'manual',\n});`;
const resultNode = { id: 'verify-publication-result', name: resultName, type: 'n8n-nodes-base.code', typeVersion: 2,
  position: [100, 70], parameters: { jsCode: resultCode } };
workflow.nodes = [...workflow.nodes.filter(candidate => candidate.id !== resultNode.id), resultNode];
workflow.connections[node.name] = { main: [[{ node: resultName, type: 'main', index: 0 }]] };
workflow.description = 'Daily 16:30 Europe/Belgrade agenda for the next three days: the publication-date art direction is shared with today\'s Story and Reel; pages vary within that palette. Unposted events first across recent posts and Reels, repeats only to fill sparse dates. Up to three events per page, mandatory final Zeka zna website card, Serbian captions, venue tags, Belgrade location. Preserve one feed post per date, reconciliation receipts and safe manual previews.';
const schedule = workflow.nodes.find(candidate => candidate.type === 'n8n-nodes-base.scheduleTrigger');
const oldName = schedule.name;
schedule.name = 'Daily at 16:30 Belgrade';
schedule.parameters.rule.interval = [{ field: 'cronExpression', expression: '30 16 * * *' }, { field: 'cronExpression', expression: '0 17 * * *' }, { field: 'cronExpression', expression: '30 17 * * *' }];
if (oldName !== schedule.name && workflow.connections[oldName]) {
  workflow.connections[schedule.name] = workflow.connections[oldName];
  delete workflow.connections[oldName];
}
workflow.settings.timezone = 'Europe/Belgrade';
workflow.settings.executionTimeout = 900;
workflow.active = false;
workflow.staticData = null;
workflow.versionId = '2c826ca4-51d0-4fbc-9e55-4c06c5e6a398';
workflow.versionCounter = 2;
writeFileSync(path, `${JSON.stringify(workflows, null, 2)}\n`);
console.log('Built inactive three-day agenda workflow export; live deployment must preserve existing staticData.');
