import { writeFileSync } from 'node:fs';
import { publishEventZekaStories, publishPreparedInstagramStory, hasPublishedInstagramStoryToday } from '../ops/n8n/publish-daily-stories.mjs';
import { fetchEventZekaPublicationContext, rememberEventZekaSelection } from '../ops/n8n/social-publication-history.mjs';
import { assertSocialPublicationResult } from '../ops/n8n/social-publication-result.mjs';

const scheduleName = 'Daily at 10:00 Belgrade';
const codeName = 'Generate and Publish Daily Stories';
const code = `${publishEventZekaStories.toString()}\n\n${publishPreparedInstagramStory.toString()}\n\n${hasPublishedInstagramStoryToday.toString()}\n\n${fetchEventZekaPublicationContext.toString()}\n\n${rememberEventZekaSelection.toString()}\n\nreturn await publishEventZekaStories({\n  env: $env,\n  httpRequest: this.helpers.httpRequest.bind(this.helpers),\n  getStaticData: () => $getWorkflowStaticData('global'),\n  forceDryRun: $execution.mode === 'manual',\n});`;
const resultName = 'Verify Publication Result';
const resultCode = `${assertSocialPublicationResult.toString()}\n\nreturn assertSocialPublicationResult($input.all());`;

const workflow = {
  id: 'EzekaDailyStory001',
  name: 'Event Zeka - Daily Stories at 10:00',
  description: 'Daily 10:00 Europe/Belgrade: one 18-second DANAS video Story with up to four approved events and the mandatory Zeka zna closing CTA. Native venue mentions, Belgrade location metadata, and the publication-date art direction shared with today\'s feed and Reel. Material deformation and vector motion; text stays upright. Preserve active-Story duplicate checks, exact receipts, definitive-rejection-only retries, and safe manual previews. Instagram catalog music remains Reels-only.',
  active: false,
  nodes: [
    { id: 'manual-story-preview', name: 'Manual Story Preview', type: 'n8n-nodes-base.manualTrigger', typeVersion: 1, position: [-460, -90], parameters: {} },
    { id: 'daily-story-schedule', name: scheduleName, type: 'n8n-nodes-base.scheduleTrigger', typeVersion: 1.2, position: [-460, 170], parameters: { rule: { interval: [{ field: 'cronExpression', expression: '0 10 * * *' }, { field: 'cronExpression', expression: '30 10 * * *' }, { field: 'cronExpression', expression: '0 11 * * *' }] } } },
    { id: 'generate-and-publish-stories', name: codeName, type: 'n8n-nodes-base.code', typeVersion: 2, position: [-180, 70], parameters: { jsCode: code } },
    { id: 'verify-publication-result', name: resultName, type: 'n8n-nodes-base.code', typeVersion: 2, position: [100, 70], parameters: { jsCode: resultCode } },
  ],
  connections: { ...Object.fromEntries(['Manual Story Preview', scheduleName].map(name => [name, { main: [[{ node: codeName, type: 'main', index: 0 }]] }])),
    [codeName]: { main: [[{ node: resultName, type: 'main', index: 0 }]] } },
  settings: { executionOrder: 'v1', timezone: 'Europe/Belgrade', saveDataSuccessExecution: 'all', saveDataErrorExecution: 'all', executionTimeout: 900 },
  staticData: null,
  versionId: 'b2fd73bd-2ccd-4369-9ae3-8e6427f4796c',
  versionCounter: 1,
  tags: [],
};
writeFileSync(new URL('../ops/n8n/event-zeka-daily-stories.json', import.meta.url), `${JSON.stringify([workflow], null, 2)}\n`);
console.log('Built inactive 10:00 daily Stories workflow. Activate only after the live dry run passes.');
