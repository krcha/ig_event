import { readFileSync, writeFileSync } from 'node:fs';
import { publishEventZekaCarousel } from '../ops/n8n/publish-daily-carousel.mjs';

const path = new URL('../ops/n8n/event-zeka-daily-instagram-carousel.json', import.meta.url);
const workflows = JSON.parse(readFileSync(path, 'utf8'));
const workflow = workflows.find(candidate => candidate.id === 'EzekaDailyIg001');
if (!workflow) throw new Error('Daily Event Zeka workflow is missing.');
const node = workflow.nodes.find(candidate => candidate.id === 'generate-and-publish');
node.parameters.jsCode = `${publishEventZekaCarousel.toString()}\n\nreturn await publishEventZekaCarousel({\n  env: $env,\n  httpRequest: this.helpers.httpRequest.bind(this.helpers),\n  getStaticData: () => $getWorkflowStaticData('global'),\n});`;
workflow.description = 'Daily 16:30 Europe/Belgrade agenda for the next three days: up to three approved events per page, Serbian captions, venue tags, and one feed post per date.';
const schedule = workflow.nodes.find(candidate => candidate.type === 'n8n-nodes-base.scheduleTrigger');
const oldName = schedule.name;
schedule.name = 'Daily at 16:30 Belgrade';
schedule.parameters.rule.interval[0].expression = '30 16 * * *';
if (oldName !== schedule.name && workflow.connections[oldName]) {
  workflow.connections[schedule.name] = workflow.connections[oldName];
  delete workflow.connections[oldName];
}
workflow.settings.timezone = 'Europe/Belgrade';
workflow.active = false;
workflow.staticData = null;
workflow.versionId = '2c826ca4-51d0-4fbc-9e55-4c06c5e6a398';
workflow.versionCounter = 2;
writeFileSync(path, `${JSON.stringify(workflows, null, 2)}\n`);
console.log('Built inactive three-day agenda workflow export; live deployment must preserve existing staticData.');
