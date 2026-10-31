/* eslint-disable */
/**
 * Generated `api` utility.
 *
 * THIS CODE IS AUTOMATICALLY GENERATED.
 *
 * To regenerate, run `npx convex dev`.
 * @module
 */

import type * as analytics from "../analytics.js";
import type * as analyticsValidators from "../analyticsValidators.js";
import type * as authz from "../authz.js";
import type * as automaticApprovalDiagnostics from "../automaticApprovalDiagnostics.js";
import type * as autonomousModeration from "../autonomousModeration.js";
import type * as crons from "../crons.js";
import type * as durableIngestionRuns from "../durableIngestionRuns.js";
import type * as eventDomain_coalescingSupport from "../eventDomain/coalescingSupport.js";
import type * as eventDomain_compatibilityReads from "../eventDomain/compatibilityReads.js";
import type * as eventDomain_contracts from "../eventDomain/contracts.js";
import type * as eventDomain_crossPostPromotion from "../eventDomain/crossPostPromotion.js";
import type * as eventDomain_eventCreation from "../eventDomain/eventCreation.js";
import type * as eventDomain_eventUpdates from "../eventDomain/eventUpdates.js";
import type * as eventDomain_evidencePolicy from "../eventDomain/evidencePolicy.js";
import type * as eventDomain_lifecycleCommands from "../eventDomain/lifecycleCommands.js";
import type * as eventDomain_moderationCommands from "../eventDomain/moderationCommands.js";
import type * as eventDomain_moderationReads from "../eventDomain/moderationReads.js";
import type * as eventDomain_moderationUniqueness from "../eventDomain/moderationUniqueness.js";
import type * as eventDomain_moderationVenue from "../eventDomain/moderationVenue.js";
import type * as eventDomain_nightlifeLineup from "../eventDomain/nightlifeLineup.js";
import type * as eventDomain_persistence from "../eventDomain/persistence.js";
import type * as eventDomain_publicReads from "../eventDomain/publicReads.js";
import type * as eventDomain_reviewedContinuationFold from "../eventDomain/reviewedContinuationFold.js";
import type * as eventDomain_reviewedPromotionFold from "../eventDomain/reviewedPromotionFold.js";
import type * as eventDomain_reviewedScheduleFold from "../eventDomain/reviewedScheduleFold.js";
import type * as eventDomain_reviewedStructuredCorrections from "../eventDomain/reviewedStructuredCorrections.js";
import type * as eventDomain_sourceAccountVenueFallback from "../eventDomain/sourceAccountVenueFallback.js";
import type * as eventDomain_sourceApproval from "../eventDomain/sourceApproval.js";
import type * as eventDomain_sourceGroundingReprocess from "../eventDomain/sourceGroundingReprocess.js";
import type * as eventDomain_sourceOccurrenceCompatibility from "../eventDomain/sourceOccurrenceCompatibility.js";
import type * as eventDomain_sourceUrlPolicy from "../eventDomain/sourceUrlPolicy.js";
import type * as eventDomain_trustedV2VenueRepair from "../eventDomain/trustedV2VenueRepair.js";
import type * as eventDomain_valueNormalization from "../eventDomain/valueNormalization.js";
import type * as events from "../events.js";
import type * as ingestionJobs from "../ingestionJobs.js";
import type * as instagramSources from "../instagramSources.js";
import type * as internal_automaticUniqueApproval from "../internal/automaticUniqueApproval.js";
import type * as internal_automaticUniqueApprovalPreflight from "../internal/automaticUniqueApprovalPreflight.js";
import type * as internal_automaticUniqueSourceProof from "../internal/automaticUniqueSourceProof.js";
import type * as internal_automaticUniqueVenueEvidence from "../internal/automaticUniqueVenueEvidence.js";
import type * as internal_autonomousModerationExecutor from "../internal/autonomousModerationExecutor.js";
import type * as internal_autonomousModerationRepair from "../internal/autonomousModerationRepair.js";
import type * as internal_autonomousVenueRepair from "../internal/autonomousVenueRepair.js";
import type * as internal_campaignLineageReattestationProof from "../internal/campaignLineageReattestationProof.js";
import type * as internal_carouselMediaProof from "../internal/carouselMediaProof.js";
import type * as internal_eventRepairs_approvedLegacyVenue from "../internal/eventRepairs/approvedLegacyVenue.js";
import type * as internal_eventRepairs_evidencePolicy from "../internal/eventRepairs/evidencePolicy.js";
import type * as internal_eventRepairs_pendingBenignSourceConflicts from "../internal/eventRepairs/pendingBenignSourceConflicts.js";
import type * as internal_eventRepairs_pendingSourceConflictReclassification from "../internal/eventRepairs/pendingSourceConflictReclassification.js";
import type * as internal_eventRepairs_revertFalseCinemaAutomaticApproval from "../internal/eventRepairs/revertFalseCinemaAutomaticApproval.js";
import type * as internal_eventRepairs_reviewedCaptionEvidence from "../internal/eventRepairs/reviewedCaptionEvidence.js";
import type * as internal_eventRepairs_reviewedContinuationFold from "../internal/eventRepairs/reviewedContinuationFold.js";
import type * as internal_eventRepairs_reviewedFabrikaDjNightEnrichment from "../internal/eventRepairs/reviewedFabrikaDjNightEnrichment.js";
import type * as internal_eventRepairs_reviewedFabrikaProgramEnrichment from "../internal/eventRepairs/reviewedFabrikaProgramEnrichment.js";
import type * as internal_eventRepairs_reviewedNonPerformerEvidence from "../internal/eventRepairs/reviewedNonPerformerEvidence.js";
import type * as internal_eventRepairs_reviewedPendingPerformerCorrection from "../internal/eventRepairs/reviewedPendingPerformerCorrection.js";
import type * as internal_eventRepairs_reviewedPromoterScheduleFold from "../internal/eventRepairs/reviewedPromoterScheduleFold.js";
import type * as internal_eventRepairs_reviewedPromotionFold from "../internal/eventRepairs/reviewedPromotionFold.js";
import type * as internal_eventRepairs_reviewedScheduleFold from "../internal/eventRepairs/reviewedScheduleFold.js";
import type * as internal_eventRepairs_reviewedStructuredCaptionCorrection from "../internal/eventRepairs/reviewedStructuredCaptionCorrection.js";
import type * as internal_eventRepairs_reviewedStructuredCorrections from "../internal/eventRepairs/reviewedStructuredCorrections.js";
import type * as internal_eventRepairs_reviewedVenueRepairContext from "../internal/eventRepairs/reviewedVenueRepairContext.js";
import type * as internal_eventRepairs_sourceBoundEmptyV2Venue from "../internal/eventRepairs/sourceBoundEmptyV2Venue.js";
import type * as internal_eventRepairs_sourceGroundingReprocess from "../internal/eventRepairs/sourceGroundingReprocess.js";
import type * as internal_eventRepairs_trustedV2VenueRepair from "../internal/eventRepairs/trustedV2VenueRepair.js";
import type * as internal_eventVenueBindingCoverage from "../internal/eventVenueBindingCoverage.js";
import type * as internal_extractionModel from "../internal/extractionModel.js";
import type * as internal_focusedConflictReviewProof from "../internal/focusedConflictReviewProof.js";
import type * as internal_legacySourceOccurrenceAdmissionProof from "../internal/legacySourceOccurrenceAdmissionProof.js";
import type * as internal_migrations_campaignLineage from "../internal/migrations/campaignLineage.js";
import type * as internal_migrations_canonicalFields from "../internal/migrations/canonicalFields.js";
import type * as internal_migrations_eventDomain from "../internal/migrations/eventDomain.js";
import type * as internal_migrations_eventDomainShared from "../internal/migrations/eventDomainShared.js";
import type * as internal_migrations_eventVenueBindings from "../internal/migrations/eventVenueBindings.js";
import type * as internal_migrations_legacySourceOccurrenceAdmission from "../internal/migrations/legacySourceOccurrenceAdmission.js";
import type * as internal_migrations_publication from "../internal/migrations/publication.js";
import type * as internal_migrations_reviewedKolaracVenueConsolidation from "../internal/migrations/reviewedKolaracVenueConsolidation.js";
import type * as internal_migrations_reviewedMadlenianumDuplicateRewire from "../internal/migrations/reviewedMadlenianumDuplicateRewire.js";
import type * as internal_migrations_reviewedMrakOccurrenceCorrection from "../internal/migrations/reviewedMrakOccurrenceCorrection.js";
import type * as internal_migrations_reviewedOfficialVenueDirectoryAdditions from "../internal/migrations/reviewedOfficialVenueDirectoryAdditions.js";
import type * as internal_migrations_savedEvents from "../internal/migrations/savedEvents.js";
import type * as internal_migrations_sourceOccurrenceBackfill from "../internal/migrations/sourceOccurrenceBackfill.js";
import type * as internal_migrations_sourceOccurrenceCanonicalPayload from "../internal/migrations/sourceOccurrenceCanonicalPayload.js";
import type * as internal_migrations_sourceOccurrenceTopologyAudit from "../internal/migrations/sourceOccurrenceTopologyAudit.js";
import type * as internal_migrations_venueIdentity from "../internal/migrations/venueIdentity.js";
import type * as internal_receiptTopologyCoverage from "../internal/receiptTopologyCoverage.js";
import type * as internal_reconciliationApplyReadiness from "../internal/reconciliationApplyReadiness.js";
import type * as internal_reconciliationCanonicalEventWriter from "../internal/reconciliationCanonicalEventWriter.js";
import type * as internal_reconciliationCanonicalExecutor from "../internal/reconciliationCanonicalExecutor.js";
import type * as internal_reconciliationFullOutcome from "../internal/reconciliationFullOutcome.js";
import type * as internal_reconciliationObservedOutcomeVerifier from "../internal/reconciliationObservedOutcomeVerifier.js";
import type * as internal_reconciliationOccurrenceContext from "../internal/reconciliationOccurrenceContext.js";
import type * as internal_reconciliationPrerequisites from "../internal/reconciliationPrerequisites.js";
import type * as internal_reconciliationReceiptFacts from "../internal/reconciliationReceiptFacts.js";
import type * as internal_reconciliationRollout from "../internal/reconciliationRollout.js";
import type * as internal_reconciliationRolloutVerification from "../internal/reconciliationRolloutVerification.js";
import type * as internal_reconciliationSourceAudit from "../internal/reconciliationSourceAudit.js";
import type * as internal_reconciliationSourceExecutor from "../internal/reconciliationSourceExecutor.js";
import type * as internal_reconciliationSourceOutcome from "../internal/reconciliationSourceOutcome.js";
import type * as internal_reconciliationSourcePersistence from "../internal/reconciliationSourcePersistence.js";
import type * as internal_reconciliationVerificationInputs from "../internal/reconciliationVerificationInputs.js";
import type * as internal_requestBounds from "../internal/requestBounds.js";
import type * as internal_retentionReceiptCoverage from "../internal/retentionReceiptCoverage.js";
import type * as internal_sourceConflictReviewContext from "../internal/sourceConflictReviewContext.js";
import type * as internal_sourceOccurrenceLimits from "../internal/sourceOccurrenceLimits.js";
import type * as internal_sourceOccurrenceReceipts from "../internal/sourceOccurrenceReceipts.js";
import type * as internal_sourceOccurrenceTopologyEpoch from "../internal/sourceOccurrenceTopologyEpoch.js";
import type * as legacyDefinitiveOutputRecoveryAllowlist from "../legacyDefinitiveOutputRecoveryAllowlist.js";
import type * as maintenance from "../maintenance.js";
import type * as mediaActions from "../mediaActions.js";
import type * as mediaAssets from "../mediaAssets.js";
import type * as pendingSourceConflictReclassification from "../pendingSourceConflictReclassification.js";
import type * as publicCalendarOverview from "../publicCalendarOverview.js";
import type * as publicCalendarOverviewAction from "../publicCalendarOverviewAction.js";
import type * as publicEventGrounding from "../publicEventGrounding.js";
import type * as publicEventProjection from "../publicEventProjection.js";
import type * as publicationCutover from "../publicationCutover.js";
import type * as publicationPolicy from "../publicationPolicy.js";
import type * as reconciliation from "../reconciliation.js";
import type * as reconciliationIngress from "../reconciliationIngress.js";
import type * as repositories_occurrenceCandidates from "../repositories/occurrenceCandidates.js";
import type * as repositories_reconciliationSourceContext from "../repositories/reconciliationSourceContext.js";
import type * as repositories_savedEvents from "../repositories/savedEvents.js";
import type * as repositories_sourceOccurrenceProvenance from "../repositories/sourceOccurrenceProvenance.js";
import type * as revertFalseCinemaAutomaticApproval from "../revertFalseCinemaAutomaticApproval.js";
import type * as reviewedPromoterScheduleFold from "../reviewedPromoterScheduleFold.js";
import type * as scrapedPosts from "../scrapedPosts.js";
import type * as sourceConflictReviews from "../sourceConflictReviews.js";
import type * as sourceOccurrences from "../sourceOccurrences.js";
import type * as users from "../users.js";
import type * as venueHoursBackfill from "../venueHoursBackfill.js";
import type * as venueIdentities from "../venueIdentities.js";
import type * as venueResolver from "../venueResolver.js";
import type * as venues from "../venues.js";

import type {
  ApiFromModules,
  FilterApi,
  FunctionReference,
} from "convex/server";

declare const fullApi: ApiFromModules<{
  analytics: typeof analytics;
  analyticsValidators: typeof analyticsValidators;
  authz: typeof authz;
  automaticApprovalDiagnostics: typeof automaticApprovalDiagnostics;
  autonomousModeration: typeof autonomousModeration;
  crons: typeof crons;
  durableIngestionRuns: typeof durableIngestionRuns;
  "eventDomain/coalescingSupport": typeof eventDomain_coalescingSupport;
  "eventDomain/compatibilityReads": typeof eventDomain_compatibilityReads;
  "eventDomain/contracts": typeof eventDomain_contracts;
  "eventDomain/crossPostPromotion": typeof eventDomain_crossPostPromotion;
  "eventDomain/eventCreation": typeof eventDomain_eventCreation;
  "eventDomain/eventUpdates": typeof eventDomain_eventUpdates;
  "eventDomain/evidencePolicy": typeof eventDomain_evidencePolicy;
  "eventDomain/lifecycleCommands": typeof eventDomain_lifecycleCommands;
  "eventDomain/moderationCommands": typeof eventDomain_moderationCommands;
  "eventDomain/moderationReads": typeof eventDomain_moderationReads;
  "eventDomain/moderationUniqueness": typeof eventDomain_moderationUniqueness;
  "eventDomain/moderationVenue": typeof eventDomain_moderationVenue;
  "eventDomain/nightlifeLineup": typeof eventDomain_nightlifeLineup;
  "eventDomain/persistence": typeof eventDomain_persistence;
  "eventDomain/publicReads": typeof eventDomain_publicReads;
  "eventDomain/reviewedContinuationFold": typeof eventDomain_reviewedContinuationFold;
  "eventDomain/reviewedPromotionFold": typeof eventDomain_reviewedPromotionFold;
  "eventDomain/reviewedScheduleFold": typeof eventDomain_reviewedScheduleFold;
  "eventDomain/reviewedStructuredCorrections": typeof eventDomain_reviewedStructuredCorrections;
  "eventDomain/sourceAccountVenueFallback": typeof eventDomain_sourceAccountVenueFallback;
  "eventDomain/sourceApproval": typeof eventDomain_sourceApproval;
  "eventDomain/sourceGroundingReprocess": typeof eventDomain_sourceGroundingReprocess;
  "eventDomain/sourceOccurrenceCompatibility": typeof eventDomain_sourceOccurrenceCompatibility;
  "eventDomain/sourceUrlPolicy": typeof eventDomain_sourceUrlPolicy;
  "eventDomain/trustedV2VenueRepair": typeof eventDomain_trustedV2VenueRepair;
  "eventDomain/valueNormalization": typeof eventDomain_valueNormalization;
  events: typeof events;
  ingestionJobs: typeof ingestionJobs;
  instagramSources: typeof instagramSources;
  "internal/automaticUniqueApproval": typeof internal_automaticUniqueApproval;
  "internal/automaticUniqueApprovalPreflight": typeof internal_automaticUniqueApprovalPreflight;
  "internal/automaticUniqueSourceProof": typeof internal_automaticUniqueSourceProof;
  "internal/automaticUniqueVenueEvidence": typeof internal_automaticUniqueVenueEvidence;
  "internal/autonomousModerationExecutor": typeof internal_autonomousModerationExecutor;
  "internal/autonomousModerationRepair": typeof internal_autonomousModerationRepair;
  "internal/autonomousVenueRepair": typeof internal_autonomousVenueRepair;
  "internal/campaignLineageReattestationProof": typeof internal_campaignLineageReattestationProof;
  "internal/carouselMediaProof": typeof internal_carouselMediaProof;
  "internal/eventRepairs/approvedLegacyVenue": typeof internal_eventRepairs_approvedLegacyVenue;
  "internal/eventRepairs/evidencePolicy": typeof internal_eventRepairs_evidencePolicy;
  "internal/eventRepairs/pendingBenignSourceConflicts": typeof internal_eventRepairs_pendingBenignSourceConflicts;
  "internal/eventRepairs/pendingSourceConflictReclassification": typeof internal_eventRepairs_pendingSourceConflictReclassification;
  "internal/eventRepairs/revertFalseCinemaAutomaticApproval": typeof internal_eventRepairs_revertFalseCinemaAutomaticApproval;
  "internal/eventRepairs/reviewedCaptionEvidence": typeof internal_eventRepairs_reviewedCaptionEvidence;
  "internal/eventRepairs/reviewedContinuationFold": typeof internal_eventRepairs_reviewedContinuationFold;
  "internal/eventRepairs/reviewedFabrikaDjNightEnrichment": typeof internal_eventRepairs_reviewedFabrikaDjNightEnrichment;
  "internal/eventRepairs/reviewedFabrikaProgramEnrichment": typeof internal_eventRepairs_reviewedFabrikaProgramEnrichment;
  "internal/eventRepairs/reviewedNonPerformerEvidence": typeof internal_eventRepairs_reviewedNonPerformerEvidence;
  "internal/eventRepairs/reviewedPendingPerformerCorrection": typeof internal_eventRepairs_reviewedPendingPerformerCorrection;
  "internal/eventRepairs/reviewedPromoterScheduleFold": typeof internal_eventRepairs_reviewedPromoterScheduleFold;
  "internal/eventRepairs/reviewedPromotionFold": typeof internal_eventRepairs_reviewedPromotionFold;
  "internal/eventRepairs/reviewedScheduleFold": typeof internal_eventRepairs_reviewedScheduleFold;
  "internal/eventRepairs/reviewedStructuredCaptionCorrection": typeof internal_eventRepairs_reviewedStructuredCaptionCorrection;
  "internal/eventRepairs/reviewedStructuredCorrections": typeof internal_eventRepairs_reviewedStructuredCorrections;
  "internal/eventRepairs/reviewedVenueRepairContext": typeof internal_eventRepairs_reviewedVenueRepairContext;
  "internal/eventRepairs/sourceBoundEmptyV2Venue": typeof internal_eventRepairs_sourceBoundEmptyV2Venue;
  "internal/eventRepairs/sourceGroundingReprocess": typeof internal_eventRepairs_sourceGroundingReprocess;
  "internal/eventRepairs/trustedV2VenueRepair": typeof internal_eventRepairs_trustedV2VenueRepair;
  "internal/eventVenueBindingCoverage": typeof internal_eventVenueBindingCoverage;
  "internal/extractionModel": typeof internal_extractionModel;
  "internal/focusedConflictReviewProof": typeof internal_focusedConflictReviewProof;
  "internal/legacySourceOccurrenceAdmissionProof": typeof internal_legacySourceOccurrenceAdmissionProof;
  "internal/migrations/campaignLineage": typeof internal_migrations_campaignLineage;
  "internal/migrations/canonicalFields": typeof internal_migrations_canonicalFields;
  "internal/migrations/eventDomain": typeof internal_migrations_eventDomain;
  "internal/migrations/eventDomainShared": typeof internal_migrations_eventDomainShared;
  "internal/migrations/eventVenueBindings": typeof internal_migrations_eventVenueBindings;
  "internal/migrations/legacySourceOccurrenceAdmission": typeof internal_migrations_legacySourceOccurrenceAdmission;
  "internal/migrations/publication": typeof internal_migrations_publication;
  "internal/migrations/reviewedKolaracVenueConsolidation": typeof internal_migrations_reviewedKolaracVenueConsolidation;
  "internal/migrations/reviewedMadlenianumDuplicateRewire": typeof internal_migrations_reviewedMadlenianumDuplicateRewire;
  "internal/migrations/reviewedMrakOccurrenceCorrection": typeof internal_migrations_reviewedMrakOccurrenceCorrection;
  "internal/migrations/reviewedOfficialVenueDirectoryAdditions": typeof internal_migrations_reviewedOfficialVenueDirectoryAdditions;
  "internal/migrations/savedEvents": typeof internal_migrations_savedEvents;
  "internal/migrations/sourceOccurrenceBackfill": typeof internal_migrations_sourceOccurrenceBackfill;
  "internal/migrations/sourceOccurrenceCanonicalPayload": typeof internal_migrations_sourceOccurrenceCanonicalPayload;
  "internal/migrations/sourceOccurrenceTopologyAudit": typeof internal_migrations_sourceOccurrenceTopologyAudit;
  "internal/migrations/venueIdentity": typeof internal_migrations_venueIdentity;
  "internal/receiptTopologyCoverage": typeof internal_receiptTopologyCoverage;
  "internal/reconciliationApplyReadiness": typeof internal_reconciliationApplyReadiness;
  "internal/reconciliationCanonicalEventWriter": typeof internal_reconciliationCanonicalEventWriter;
  "internal/reconciliationCanonicalExecutor": typeof internal_reconciliationCanonicalExecutor;
  "internal/reconciliationFullOutcome": typeof internal_reconciliationFullOutcome;
  "internal/reconciliationObservedOutcomeVerifier": typeof internal_reconciliationObservedOutcomeVerifier;
  "internal/reconciliationOccurrenceContext": typeof internal_reconciliationOccurrenceContext;
  "internal/reconciliationPrerequisites": typeof internal_reconciliationPrerequisites;
  "internal/reconciliationReceiptFacts": typeof internal_reconciliationReceiptFacts;
  "internal/reconciliationRollout": typeof internal_reconciliationRollout;
  "internal/reconciliationRolloutVerification": typeof internal_reconciliationRolloutVerification;
  "internal/reconciliationSourceAudit": typeof internal_reconciliationSourceAudit;
  "internal/reconciliationSourceExecutor": typeof internal_reconciliationSourceExecutor;
  "internal/reconciliationSourceOutcome": typeof internal_reconciliationSourceOutcome;
  "internal/reconciliationSourcePersistence": typeof internal_reconciliationSourcePersistence;
  "internal/reconciliationVerificationInputs": typeof internal_reconciliationVerificationInputs;
  "internal/requestBounds": typeof internal_requestBounds;
  "internal/retentionReceiptCoverage": typeof internal_retentionReceiptCoverage;
  "internal/sourceConflictReviewContext": typeof internal_sourceConflictReviewContext;
  "internal/sourceOccurrenceLimits": typeof internal_sourceOccurrenceLimits;
  "internal/sourceOccurrenceReceipts": typeof internal_sourceOccurrenceReceipts;
  "internal/sourceOccurrenceTopologyEpoch": typeof internal_sourceOccurrenceTopologyEpoch;
  legacyDefinitiveOutputRecoveryAllowlist: typeof legacyDefinitiveOutputRecoveryAllowlist;
  maintenance: typeof maintenance;
  mediaActions: typeof mediaActions;
  mediaAssets: typeof mediaAssets;
  pendingSourceConflictReclassification: typeof pendingSourceConflictReclassification;
  publicCalendarOverview: typeof publicCalendarOverview;
  publicCalendarOverviewAction: typeof publicCalendarOverviewAction;
  publicEventGrounding: typeof publicEventGrounding;
  publicEventProjection: typeof publicEventProjection;
  publicationCutover: typeof publicationCutover;
  publicationPolicy: typeof publicationPolicy;
  reconciliation: typeof reconciliation;
  reconciliationIngress: typeof reconciliationIngress;
  "repositories/occurrenceCandidates": typeof repositories_occurrenceCandidates;
  "repositories/reconciliationSourceContext": typeof repositories_reconciliationSourceContext;
  "repositories/savedEvents": typeof repositories_savedEvents;
  "repositories/sourceOccurrenceProvenance": typeof repositories_sourceOccurrenceProvenance;
  revertFalseCinemaAutomaticApproval: typeof revertFalseCinemaAutomaticApproval;
  reviewedPromoterScheduleFold: typeof reviewedPromoterScheduleFold;
  scrapedPosts: typeof scrapedPosts;
  sourceConflictReviews: typeof sourceConflictReviews;
  sourceOccurrences: typeof sourceOccurrences;
  users: typeof users;
  venueHoursBackfill: typeof venueHoursBackfill;
  venueIdentities: typeof venueIdentities;
  venueResolver: typeof venueResolver;
  venues: typeof venues;
}>;

/**
 * A utility for referencing Convex functions in your app's public API.
 *
 * Usage:
 * ```js
 * const myFunctionReference = api.myModule.myFunction;
 * ```
 */
export declare const api: FilterApi<
  typeof fullApi,
  FunctionReference<any, "public">
>;

/**
 * A utility for referencing Convex functions in your app's internal API.
 *
 * Usage:
 * ```js
 * const myFunctionReference = internal.myModule.myFunction;
 * ```
 */
export declare const internal: FilterApi<
  typeof fullApi,
  FunctionReference<any, "internal">
>;

export declare const components: {};
