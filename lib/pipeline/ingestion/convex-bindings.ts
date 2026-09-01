import { type FunctionReference } from "convex/server";

export const getByInstagramPostIdQuery =
  "events:getByInstagramPostId" as unknown as FunctionReference<"query">;


export const getByInstagramPostUrlQuery =
  "events:getByInstagramPostUrl" as unknown as FunctionReference<"query">;


export const listByInstagramPostIdQuery =
  "events:listByInstagramPostId" as unknown as FunctionReference<"query">;


export const listByInstagramPostUrlQuery =
  "events:listByInstagramPostUrl" as unknown as FunctionReference<"query">;


export const listByStatusQuery =
  "events:listByStatus" as unknown as FunctionReference<"query">;


export const listCandidatesForNormalizedOccurrenceQuery =
  "sourceOccurrences:listCandidatesForNormalizedOccurrence" as unknown as FunctionReference<"query">;


export const reconcileIngestionPlanMutation =
  "reconciliationIngress:reconcileIngestionPlan" as unknown as FunctionReference<"mutation">;


export const createEventMutation =
  "events:createEvent" as unknown as FunctionReference<"mutation">;


export const getEventQuery =
  "events:getEvent" as unknown as FunctionReference<"query">;


export const getInstagramSourceOccurrenceReceiptQuery =
  "events:getInstagramSourceOccurrenceReceipt" as unknown as FunctionReference<"query">;


export const recordInstagramSourceOccurrenceSatisfactionMutation =
  "events:recordInstagramSourceOccurrenceSatisfaction" as unknown as FunctionReference<"mutation">;


export const reconcileInstagramSourceOccurrenceReceiptMutation =
  "events:reconcileInstagramSourceOccurrenceReceipt" as unknown as FunctionReference<"mutation">;


export const updateSourceOccurrenceExpectedCountMutation =
  "events:updateSourceOccurrenceExpectedCount" as unknown as FunctionReference<"mutation">;


export const updateEventMutation =
  "events:updateEvent" as unknown as FunctionReference<"mutation">;


export const updateEventAndRecordInstagramSourceOccurrenceSatisfactionMutation =
  "events:updateEventAndRecordInstagramSourceOccurrenceSatisfaction" as unknown as FunctionReference<"mutation">;


export const persistInstagramImageAction =
  "mediaActions:persistInstagramImage" as unknown as FunctionReference<"action">;


export const listScrapedPostsByHandleQuery =
  "scrapedPosts:listByHandle" as unknown as FunctionReference<"query">;


export const listScrapedPostsByHandlePaginatedQuery =
  "scrapedPosts:listByHandlePaginated" as unknown as FunctionReference<"query">;


export const getScrapedPostsManyByIdsQuery =
  "scrapedPosts:getManyByIds" as unknown as FunctionReference<"query">;


export const getScrapedPostsManyByHandleAndPostRefsQuery =
  "scrapedPosts:getManyByHandleAndPostRefs" as unknown as FunctionReference<"query">;


export const upsertScrapedPostsByHandleMutation =
  "scrapedPosts:upsertManyByHandle" as unknown as FunctionReference<"mutation">;


export const recordScrapedPostProcessingResultMutation =
  "scrapedPosts:recordProcessingResult" as unknown as FunctionReference<"mutation">;


export const recordScrapedPostOpenAiAnalysisMutation =
  "scrapedPosts:recordOpenAiAnalysis" as unknown as FunctionReference<"mutation">;


export const recordScrapedPostOpenAiDefinitiveOutputFailureMutation =
  "scrapedPosts:recordOpenAiDefinitiveOutputFailure" as unknown as FunctionReference<"mutation">;


export const markScrapedPostOpenAiAnalysisAttemptStartedMutation =
  "scrapedPosts:markOpenAiAnalysisAttemptStarted" as unknown as FunctionReference<"mutation">;


export const releaseScrapedPostOpenAiAnalysisAttemptMutation =
  "scrapedPosts:releaseOpenAiAnalysisAttempt" as unknown as FunctionReference<"mutation">;


export const claimScrapedPostProcessingMutation =
  "scrapedPosts:claimProcessing" as unknown as FunctionReference<"mutation">;


export const getScrapedPostBacklogStateByHandleQuery =
  "scrapedPosts:getBacklogStateByHandle" as unknown as FunctionReference<"query">;


export const claimPaidFetchLeaseMutation =
  "scrapedPosts:claimPaidFetchLease" as unknown as FunctionReference<"mutation">;


export const markPaidFetchRequestStartedMutation =
  "scrapedPosts:markPaidFetchRequestStarted" as unknown as FunctionReference<"mutation">;


export const releasePaidFetchLeaseMutation =
  "scrapedPosts:releasePaidFetchLease" as unknown as FunctionReference<"mutation">;


export const recordPaidFetchWindowSaturationMutation =
  "scrapedPosts:recordPaidFetchWindowSaturation" as unknown as FunctionReference<"mutation">;


export const recordPaidFetchWindowSuccessMutation =
  "scrapedPosts:recordPaidFetchWindowSuccess" as unknown as FunctionReference<"mutation">;


export const claimProviderLeaseMutation =
  "scrapedPosts:claimProviderLease" as unknown as FunctionReference<"mutation">;


export const blockProviderMutation =
  "scrapedPosts:blockProvider" as unknown as FunctionReference<"mutation">;


export const releaseProviderLeaseMutation =
  "scrapedPosts:releaseProviderLease" as unknown as FunctionReference<"mutation">;


export const listActiveInstagramSourceHandlesPageQuery =
  "instagramSources:listActiveSourceHandlesPage" as unknown as FunctionReference<"query">;


export const listLegacyVenueHandlesPageQuery =
  "instagramSources:listLegacyVenueHandlesPage" as unknown as FunctionReference<"query">;


export const getInstagramIngestionContextsByHandlesQuery =
  "instagramSources:getIngestionContextsByHandles" as unknown as FunctionReference<"query">;
