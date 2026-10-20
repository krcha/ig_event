import { writeFileSync } from 'node:fs';
import { publishEventZekaReel } from '../ops/n8n/publish-daily-reels.mjs';
import { fetchEventZekaPublicationContext, rememberEventZekaSelection } from '../ops/n8n/social-publication-history.mjs';
import { assertSocialPublicationResult } from '../ops/n8n/social-publication-result.mjs';

const schedule = 'Daily at 19:30 Belgrade';
const node = 'Generate and Publish Tomorrow Reel';
const code = `${publishEventZekaReel.toString()}\n\n${fetchEventZekaPublicationContext.toString()}\n\n${rememberEventZekaSelection.toString()}\n\nreturn await publishEventZekaReel({\n  env: $env,\n  httpRequest: this.helpers.httpRequest.bind(this.helpers),\n  getStaticData: () => $getWorkflowStaticData('global'),\n  forceDryRun: $execution.mode === 'manual',\n});`;
const resultName = 'Verify Publication Result';
const resultCode = `${assertSocialPublicationResult.toString()}\n\nreturn assertSocialPublicationResult($input.all());`;

const workflow = {
  id: 'EzekaDailyReel001', name: 'Event Zeka - Tomorrow Reel at 19:30',
  description: 'Daily 19:30 Europe/Belgrade: a Reels-only 18-second SUTRA Reel with up to four tomorrow events and the mandatory Zeka zna closing CTA. Material deformation and vector motion use the same publication-date art direction as today\'s Story and feed. Unposted events first; off the profile grid, random song among the first three distinct eligible live catalog tracks of at least 18 seconds, and Belgrade location. Preserve exact preparation, ambiguous-publish blocking and safe manual previews.',
  active: false,
  nodes: [
    { id: 'manual-reel-preview', name: 'Manual Reel Preview', type: 'n8n-nodes-base.manualTrigger', typeVersion: 1, position: [-460,-90], parameters: {} },
    { id: 'daily-reel-schedule', name: schedule, type: 'n8n-nodes-base.scheduleTrigger', typeVersion: 1.2, position: [-460,170], parameters: { rule: { interval: [{ field: 'cronExpression', expression: '30 19 * * *' }, { field: 'cronExpression', expression: '0 20 * * *' }, { field: 'cronExpression', expression: '30 20 * * *' }] } } },
    { id: 'generate-and-publish-reel', name: node, type: 'n8n-nodes-base.code', typeVersion: 2, position: [-180,70], parameters: { jsCode: code } },
    { id: 'verify-publication-result', name: resultName, type: 'n8n-nodes-base.code', typeVersion: 2, position: [100, 70], parameters: { jsCode: resultCode } },
  ],
  connections: { ...Object.fromEntries(['Manual Reel Preview',schedule].map(name => [name,{ main: [[{ node, type: 'main', index: 0 }]] }])),
    [node]: { main: [[{ node: resultName, type: 'main', index: 0 }]] } },
  settings: { executionOrder: 'v1', timezone: 'Europe/Belgrade', saveDataSuccessExecution: 'all', saveDataErrorExecution: 'all', executionTimeout: 900 },
  staticData: null, versionId: 'af7ff77a-ab53-472d-8978-58e58e1175d7', versionCounter: 1, tags: [],
};
writeFileSync(new URL('../ops/n8n/event-zeka-daily-reels.json',import.meta.url), `${JSON.stringify([workflow],null,2)}\n`);
console.log('Built inactive 19:30 tomorrow Reel workflow. Catalog-music connection and location must be verified before activation.');
