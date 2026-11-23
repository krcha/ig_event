import type { Locale } from "@/i18n/config";
import type { CompassRecommendationReason } from "@/lib/travel/compass";
import { compassRecommendationReasonText, travelText } from "@/lib/travel/copy";
import styles from "./compass-flow.module.css";

export function CompassMatchSpectrum({ score, reason, locale }: {
  score: number | null;
  reason: CompassRecommendationReason;
  locale: Locale;
}) {
  if (score === null) return null;

  const explanation = compassRecommendationReasonText(locale, reason);
  return <div className={styles.matchSpectrum}>
    <div className={styles.matchSummary}>
      <span>{explanation}</span>
      <span aria-hidden="true" className={styles.matchScore}>{score}<span> / 100</span></span>
    </div>
    <div className={styles.matchScale}>
      <span aria-hidden="true">{travelText(locale, "spectrumDifferent")}</span>
      <div className={styles.matchTrack} role="meter" aria-label={travelText(locale, "similarityScore")}
        aria-valuemin={0} aria-valuemax={100} aria-valuenow={score}>
        <span className={styles.matchMarker} style={{ left: `${score}%` }} />
      </div>
      <span aria-hidden="true">{travelText(locale, "spectrumSimilar")}</span>
    </div>
  </div>;
}
