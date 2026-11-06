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
  return (
    <>
      <p className={styles.platformNote}>U Safariju na iPhone-u</p>
      <ol className={styles.steps}>
        <Step
          title="Otvori deljenje"
          diagram={(
            <Diagram label="Ilustracija Safari menija: izaberi Share, ikonicu deljenja.">
              <div className={styles.browserAddress}><span>eventzeka.com</span><RefreshCw aria-hidden="true" /></div>
              <div className={`${styles.menuLine} ${styles.highlight}`}><Share aria-hidden="true" /><strong>Share</strong><span className={styles.tapCaption}>Dodirni ovde</span></div>
              <div className={`${styles.menuLine} ${styles.mutedLine}`}><Bookmark aria-hidden="true" />Add to Bookmarks</div>
            </Diagram>
          )}
        >
          Dodirni <strong>Share</strong> <Share aria-hidden="true" className={styles.inlineIcon} />. Ako ga ne vidiš, otvori meni stranice pa izaberi Share.
        </Step>
        <Step
          title="Dodaj na početni ekran"
          diagram={(
            <Diagram label="Ilustracija liste deljenja: izaberi Add to Home Screen.">
              <div className={styles.sharePreview}><AppIcon size={32} /><div><strong>Event Zeka</strong><span>eventzeka.com</span></div></div>
              <div className={`${styles.menuLine} ${styles.mutedLine}`}><Search aria-hidden="true" />Find on Page</div>
              <div className={`${styles.menuLine} ${styles.highlight}`}><Plus aria-hidden="true" /><strong>Add to Home Screen</strong></div>
            </Diagram>
          )}
        >
          U listi pronađi <strong>Add to Home Screen</strong>. Po potrebi pomeri listu nadole.
        </Step>
        <Step
          title="Potvrdi dodavanje"
          diagram={(
            <Diagram label="Ilustracija potvrde: Open as Web App je uključeno, a Add potvrđuje dodavanje.">
              <div className={styles.confirmTop}><span>Cancel</span><strong>Add to Home Screen</strong><span className={styles.nativeAction}>Add</span></div>
              <AppIdentity />
              <div className={styles.switchRow}><span>Open as Web App</span><span aria-hidden="true" className={styles.nativeSwitch} /></div>
            </Diagram>
          )}
        >
          Ako se prikazuje <strong>Open as Web App</strong>, ostavi uključeno. Zatim dodirni <strong>Add</strong>.
        </Step>
      </ol>
      <p className={styles.browserFootnote}>Ilustracije menija. Nazivi i raspored zavise od verzije i jezika iOS-a.</p>
    </>
  );
}

function AndroidSteps() {
  return (
    <>
      <p className={styles.platformNote}>U Chrome-u na Android telefonu</p>
      <ol className={styles.steps}>
        <Step
          title="Otvori Chrome meni"
          diagram={(
            <Diagram label="Ilustracija Chrome adresne trake: otvori meni sa tri tačke.">
              <div className={styles.chromeAddress}><span>eventzeka.com</span><span className={`${styles.highlight} ${styles.kebab}`}><EllipsisVertical aria-hidden="true" /></span></div>
            </Diagram>
          )}
        >
          Na sajtu eventzeka.com dodirni tri tačke u Chrome-u.
        </Step>
        <Step
          title="Pronađi instaliranje"
          diagram={(
            <Diagram label="Ilustracija Chrome menija: izaberi Install and create shortcut.">
              <div className={`${styles.menuLine} ${styles.mutedLine}`}>Find in page</div>
              <div className={`${styles.menuLine} ${styles.highlight}`}><Download aria-hidden="true" /><strong>Install and create shortcut</strong></div>
            </Diagram>
          )}
        >
          Izaberi <strong>Install and create shortcut</strong>. U nekim verzijama piše Install app ili Add to Home screen.
        </Step>
        <Step
          title="Potvrdi instaliranje"
          diagram={(
            <Diagram label="Ilustracija potvrde za Event Zeka: izaberi Install.">
              <AppIdentity />
              <div className={styles.androidActions}><span>Cancel</span><strong className={styles.nativeAction}>Install</strong></div>
            </Diagram>
          )}
        >
          Dodirni <strong>Install</strong> i prati potvrdu telefona. Ako nudi samo prečicu, potvrdi dodavanje prečice.
        </Step>
      </ol>
      <p className={styles.browserFootnote}>Ilustracije menija. Dostupna opcija zavisi od Chrome-a i uređaja.</p>
    </>
  );
}

function DesktopSteps() {
  return (
    <>
      <p className={styles.platformNote}>Chrome na računaru</p>
      <ol className={styles.steps}>
        <Step title="Otvori eventzeka.com">U Chrome-u otvori meni sa tri tačke.</Step>
        <Step
          title="Pronađi instaliranje"
          diagram={(
            <Diagram label="Ilustracija Chrome menija: Cast, save, and share, pa Install page as app.">
              <div className={`${styles.menuLine} ${styles.mutedLine}`}>Cast, save, and share</div>
              <div className={`${styles.menuLine} ${styles.highlight}`}><Monitor aria-hidden="true" /><strong>Install page as app…</strong></div>
            </Diagram>
          )}
        >
          Izaberi <strong>Cast, save, and share</strong>, pa <strong>Install page as app…</strong>. Može biti dostupna i ikonica za instaliranje u adresnoj traci.
        </Step>
        <Step title="Potvrdi sa Install">Event Zeku zatim otvaraš iz liste svojih aplikacija.</Step>
      </ol>
      <details className={styles.helpDetail}>
        <summary>Koristim Safari na Mac-u</summary>
        <p>Na macOS Sonoma 14 ili novijem: Share → Add to Dock → Add. Naziv i adresu proveri pre potvrde.</p>
      </details>
      <p className={styles.browserFootnote}>Ilustracija Chrome menija. Opcije mogu da se razlikuju.</p>
    </>
  );
}

export function InstallGuide() {
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
    <main className={styles.guide} lang="sr-Latn" ref={guideRef}>
      <Link className={styles.backLink} href="/"><ArrowLeft aria-hidden="true" />Nazad na događaje</Link>
      <section className={styles.hero}>
        <Image alt="EventZeka App ikonica" className={styles.heroIcon} height={88} priority src="/event-zeka-icon-192.png" width={88} />
        <h1>Instaliraj<br /><span>EventZeka App</span></h1>
        <p>Izaberi uređaj i prati korake.</p>
      </section>
      <section className={styles.installation} aria-labelledby="install-guide-title">
        <h2 id="install-guide-title" ref={headingRef} tabIndex={-1}>Uputstvo za instalaciju</h2>
        <div aria-label="Izaberi uređaj" className={styles.platformTabs} role="tablist">
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
            >{item.label}</button>
          ))}
        </div>
        {PLATFORMS.map(item => (
          <div aria-labelledby={`install-tab-${item.id}`} hidden={platform !== item.id} id={`install-platform-${item.id}`} key={item.id} role="tabpanel" tabIndex={0}>
            {item.id === "ios" ? <IPhoneSteps /> : item.id === "android" ? <AndroidSteps /> : <DesktopSteps />}
          </div>
        ))}
        <div className={styles.guideDone}>
          <Link className="button-primary gap-3" href="/">Nazad na događaje<ArrowRight aria-hidden="true" className="h-4 w-4" /></Link>
          <p>Instalaciju potvrđuješ u pregledaču.</p>
        </div>
      </section>
      <section aria-labelledby="install-help-title" className={styles.help}>
        <h2 id="install-help-title">Ne vidiš istu opciju?</h2>
        <details className={styles.helpDetail}>
          <summary>Otvorio/la sam sajt iz Instagrama</summary>
          <p>U meniju Instagrama izaberi otvaranje u spoljašnjem pregledaču. Nastavi u Safariju na iPhone-u ili Chrome-u na Androidu.</p>
        </details>
        <details className={styles.helpDetail}>
          <summary>Šta je EventZeka App?</summary>
          <p>EventZeka App je web aplikacija koja se dodaje iz pregledača. Za pregled događaja potreban je internet.</p>
        </details>
        <details className={styles.helpDetail}>
          <summary>Gde su zvanična uputstva?</summary>
          <p className={styles.sourceLinks}>
            <a href="https://support.apple.com/guide/iphone/open-as-web-app-iphea86e5236/27/ios/27" rel="noopener noreferrer" target="_blank">Apple: iPhone</a>
            <a href="https://support.google.com/chrome/answer/9658361?co=GENIE.Platform%3DAndroid&hl=en" rel="noopener noreferrer" target="_blank">Google: Android</a>
            <a href="https://support.google.com/chrome/answer/9658361?co=GENIE.Platform%3DDesktop&hl=en" rel="noopener noreferrer" target="_blank">Google: računar</a>
            <a href="https://support.apple.com/en-ca/104996" rel="noopener noreferrer" target="_blank">Apple: Mac</a>
          </p>
        </details>
      </section>
    </main>
  );
}
