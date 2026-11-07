"use client";

import Image from "next/image";
import Link from "next/link";
import {
  ArrowLeft,
  ArrowRight,
  Bookmark,
  Download,
  EllipsisVertical,
  Monitor,
  Plus,
  RefreshCw,
  Search,
  Share,
} from "lucide-react";
import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { startInstallGuideLanding } from "@/lib/install/guide-landing";
import styles from "./install-guide.module.css";
import { useLocale } from "@/i18n/client";
import { localizeHref, LOCALE_LANGUAGE_TAGS } from "@/i18n/config";
import { accountText } from "@/lib/i18n/account-messages";

function useInstallCopy() {
  const locale = useLocale();
  return { locale, t: (key: Parameters<typeof accountText>[1]) => accountText(locale, key) };
}

type Platform = "ios" | "android" | "desktop";

const PLATFORMS: { id: Platform; label: string }[] = [
  { id: "ios", label: "iPhone" },
  { id: "android", label: "Android" },
  { id: "desktop", label: "Računar" },
];

function AppIcon({ size = 42 }: { size?: number }) {
  return <Image alt="" className={styles.appIcon} height={size} src="/event-zeka-icon-192.png" width={size} />;
}

function Diagram({ label, children }: { label: string; children: ReactNode }) {
  return <div aria-label={label} className={styles.diagram} role="img">{children}</div>;
}

function AppIdentity() {
  return (
    <div className={styles.appIdentity}>
      <AppIcon />
      <div><strong>Event Zeka</strong><span>eventzeka.com</span></div>
    </div>
  );
}

function Step({ title, children, diagram }: { title: string; children: ReactNode; diagram?: ReactNode }) {
  return (
    <li>
      <div className={styles.stepCopy}><h3>{title}</h3><p>{children}</p></div>
      {diagram}
    </li>
  );
}

function IPhoneSteps() {
  const { t } = useInstallCopy();
  return (
    <>
      <p className={styles.platformNote}>{t("install.iosNote")}</p>
      <ol className={styles.steps}>
        <Step
          title={t("install.shareTitle")}
          diagram={(
            <Diagram label={t("install.safariDiagram")}>
              <div className={styles.browserAddress}><span>eventzeka.com</span><RefreshCw aria-hidden="true" /></div>
              <div className={`${styles.menuLine} ${styles.highlight}`}><Share aria-hidden="true" /><strong>Share</strong><span className={styles.tapCaption}>{t("install.tapHere")}</span></div>
              <div className={`${styles.menuLine} ${styles.mutedLine}`}><Bookmark aria-hidden="true" />Add to Bookmarks</div>
            </Diagram>
          )}
        >
          {t("install.tap")} <strong lang="en">Share</strong> <Share aria-hidden="true" className={styles.inlineIcon} />. {t("install.shareAfter")}
        </Step>
        <Step
          title={t("install.addHome")}
          diagram={(
            <Diagram label={t("install.shareDiagram")}>
              <div className={styles.sharePreview}><AppIcon size={32} /><div><strong>Event Zeka</strong><span>eventzeka.com</span></div></div>
              <div className={`${styles.menuLine} ${styles.mutedLine}`}><Search aria-hidden="true" />Find on Page</div>
              <div className={`${styles.menuLine} ${styles.highlight}`}><Plus aria-hidden="true" /><strong>Add to Home Screen</strong></div>
            </Diagram>
          )}
        >
          {t("install.findInList")} <strong lang="en">Add to Home Screen</strong>. {t("install.scrollList")}
        </Step>
        <Step
          title={t("install.confirmAdd")}
          diagram={(
            <Diagram label={t("install.iosConfirmDiagram")}>
              <div className={styles.confirmTop}><span>Cancel</span><strong>Add to Home Screen</strong><span className={styles.nativeAction}>Add</span></div>
              <AppIdentity />
              <div className={styles.switchRow}><span>Open as Web App</span><span aria-hidden="true" className={styles.nativeSwitch} /></div>
            </Diagram>
          )}
        >
          {t("install.ifShown")} <strong lang="en">Open as Web App</strong>, {t("install.keepEnabled")} <strong lang="en">Add</strong>.
        </Step>
      </ol>
      <p className={styles.browserFootnote}>{t("install.iosFootnote")}</p>
    </>
  );
}

function AndroidSteps() {
  const { t } = useInstallCopy();
  return (
    <>
      <p className={styles.platformNote}>{t("install.androidNote")}</p>
      <ol className={styles.steps}>
        <Step
          title={t("install.openChrome")}
          diagram={(
            <Diagram label={t("install.androidMenuDiagram")}>
              <div className={styles.chromeAddress}><span>eventzeka.com</span><span className={`${styles.highlight} ${styles.kebab}`}><EllipsisVertical aria-hidden="true" /></span></div>
            </Diagram>
          )}
        >
          {t("install.androidOpen")}</Step>
        <Step
          title={t("install.findInstall")}
          diagram={(
            <Diagram label={t("install.chromeInstallDiagram")}>
              <div className={`${styles.menuLine} ${styles.mutedLine}`}>Find in page</div>
              <div className={`${styles.menuLine} ${styles.highlight}`}><Download aria-hidden="true" /><strong>Install and create shortcut</strong></div>
            </Diagram>
          )}
        >
          {t("install.choose")} <strong lang="en">Install and create shortcut</strong>. {t("install.chromeVersions")}
        </Step>
        <Step
          title={t("install.confirmInstall")}
          diagram={(
            <Diagram label={t("install.androidConfirmDiagram")}>
              <AppIdentity />
              <div className={styles.androidActions}><span>Cancel</span><strong className={styles.nativeAction}>Install</strong></div>
            </Diagram>
          )}
        >
          {t("install.tap")} <strong lang="en">Install</strong> {t("install.androidConfirm")}
        </Step>
      </ol>
      <p className={styles.browserFootnote}>{t("install.androidFootnote")}</p>
    </>
  );
}

function DesktopSteps() {
  const { t } = useInstallCopy();
  return (
    <>
      <p className={styles.platformNote}>{t("install.desktopNote")}</p>
      <ol className={styles.steps}>
        <Step title={t("install.openWebsite")}>{t("install.desktopOpen")}</Step>
        <Step
          title={t("install.findInstall")}
          diagram={(
            <Diagram label={t("install.desktopMenuDiagram")}>
              <div className={`${styles.menuLine} ${styles.mutedLine}`}>Cast, save, and share</div>
              <div className={`${styles.menuLine} ${styles.highlight}`}><Monitor aria-hidden="true" /><strong>Install page as app…</strong></div>
            </Diagram>
          )}
        >
          {t("install.choose")} <strong lang="en">Cast, save, and share</strong>, {t("install.then")} <strong lang="en">Install page as app…</strong>. {t("install.addressInstall")}
        </Step>
        <Step title={t("install.confirmWithInstall")}>{t("install.openFromApps")}</Step>
      </ol>
      <details className={styles.helpDetail}>
        <summary>{t("install.macSafari")}</summary>
        <p>{t("install.macHelp")}</p>
      </details>
      <p className={styles.browserFootnote}>{t("install.desktopFootnote")}</p>
    </>
  );
}

export function InstallGuide() {
  const { locale, t } = useInstallCopy();
  const [platform, setPlatform] = useState<Platform>("ios");
  const [platformReady, setPlatformReady] = useState(false);
  const guideRef = useRef<HTMLElement>(null);
  const headingRef = useRef<HTMLHeadingElement>(null);
  const tabRefs = useRef<Array<HTMLButtonElement | null>>([]);

  useEffect(() => {
    const agent = navigator.userAgent;
    const isIPad = navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1;
    setPlatform(/Android/i.test(agent) ? "android" : /iPhone|iPad|iPod/i.test(agent) || isIPad ? "ios" : "desktop");
    setPlatformReady(true);
  }, []);

  useLayoutEffect(() => {
    if (!platformReady || !guideRef.current || !headingRef.current) return;
    return startInstallGuideLanding(headingRef.current, guideRef.current);
  }, [platformReady]);

  function handleTabKey(event: KeyboardEvent<HTMLButtonElement>, index: number) {
    let next: number | undefined;
    if (event.key === "ArrowRight") next = (index + 1) % PLATFORMS.length;
    if (event.key === "ArrowLeft") next = (index + PLATFORMS.length - 1) % PLATFORMS.length;
    if (event.key === "Home") next = 0;
    if (event.key === "End") next = PLATFORMS.length - 1;
    if (next === undefined) return;
    event.preventDefault();
    setPlatform(PLATFORMS[next].id);
    tabRefs.current[next]?.focus();
  }

  return (
    <main className={styles.guide} lang={LOCALE_LANGUAGE_TAGS[locale]} ref={guideRef}>
      <Link className={styles.backLink} href={localizeHref("/", locale)}><ArrowLeft aria-hidden="true" />{t("install.backEvents")}</Link>
      <section className={styles.hero}>
        <Image alt={t("install.iconAlt")} className={styles.heroIcon} height={88} priority src="/event-zeka-icon-192.png" width={88} />
        <h1>{t("install.install")}<br /><span>EventZeka App</span></h1>
        <p>{t("install.pickDevice")}</p>
      </section>
      <section className={styles.installation} aria-labelledby="install-guide-title">
        <h2 id="install-guide-title" ref={headingRef} tabIndex={-1}>{t("install.instructions")}</h2>
        <div aria-label={t("install.chooseDevice")} className={styles.platformTabs} role="tablist">
          {PLATFORMS.map((item, index) => (
            <button
              aria-controls={`install-platform-${item.id}`}
              aria-selected={platform === item.id}
              id={`install-tab-${item.id}`}
              key={item.id}
              onClick={() => setPlatform(item.id)}
              onKeyDown={event => handleTabKey(event, index)}
              ref={element => { tabRefs.current[index] = element; }}
              role="tab"
              tabIndex={platform === item.id ? 0 : -1}
              type="button"
            >{item.id === "desktop" ? t("install.computer") : item.label}</button>
          ))}
        </div>
        {PLATFORMS.map(item => (
          <div aria-labelledby={`install-tab-${item.id}`} hidden={platform !== item.id} id={`install-platform-${item.id}`} key={item.id} role="tabpanel" tabIndex={0}>
            {item.id === "ios" ? <IPhoneSteps /> : item.id === "android" ? <AndroidSteps /> : <DesktopSteps />}
          </div>
        ))}
        <div className={styles.guideDone}>
          <Link className="button-primary gap-3" href={localizeHref("/", locale)}>{t("install.backEvents")}<ArrowRight aria-hidden="true" className="h-4 w-4" /></Link>
          <p>{t("install.confirmInBrowser")}</p>
        </div>
      </section>
      <section aria-labelledby="install-help-title" className={styles.help}>
        <h2 id="install-help-title">{t("install.differentOption")}</h2>
        <details className={styles.helpDetail}>
          <summary>{t("install.fromInstagram")}</summary>
          <p>{t("install.externalBrowser")}</p>
        </details>
        <details className={styles.helpDetail}>
          <summary>{t("install.whatIsApp")}</summary>
          <p>{t("install.appDefinition")}</p>
        </details>
        <details className={styles.helpDetail}>
          <summary>{t("install.officialHelp")}</summary>
          <p className={styles.sourceLinks}>
            <a href="https://support.apple.com/guide/iphone/open-as-web-app-iphea86e5236/27/ios/27" rel="noopener noreferrer" target="_blank">Apple: iPhone</a>
            <a href="https://support.google.com/chrome/answer/9658361?co=GENIE.Platform%3DAndroid&hl=en" rel="noopener noreferrer" target="_blank">Google: Android</a>
            <a href="https://support.google.com/chrome/answer/9658361?co=GENIE.Platform%3DDesktop&hl=en" rel="noopener noreferrer" target="_blank">{t("install.googleDesktop")}</a>
            <a href="https://support.apple.com/en-ca/104996" rel="noopener noreferrer" target="_blank">Apple: Mac</a>
          </p>
        </details>
      </section>
    </main>
  );
}
