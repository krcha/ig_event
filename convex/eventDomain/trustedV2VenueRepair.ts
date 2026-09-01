/**
 * Compatibility export for the reviewed trusted-v2 venue repair command.
 *
 * The implementation is migration/repair-only and therefore lives under the
 * internal repair boundary rather than the steady-state event domain.
 */
export { repairTrustedV2EventVenueHandler } from "../internal/eventRepairs/trustedV2VenueRepair";
