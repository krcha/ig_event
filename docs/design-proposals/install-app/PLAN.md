# EventZeka App: predlog instalacionog poziva i uputstva

Datum revizije: 2026-11-06. Status: lokalni dizajn i prototip za pregled.

Ovo je istorijski samostalni predlog. Implementacija u aplikaciji i njene
provere dokumentovane su u `docs/install-app.md` u korenu repozitorijuma.

Ovaj predlog ne ukljucuje promene aplikacije, produkcije, podataka, autentikacije,
ingestion procesa ili moderacije. HTML je izdvojen prikaz ideje. Primeri dogadjaja
i prikazi sistemskih menija u njemu su demonstracioni, a ne podaci uzivo ili
interaktivni meniji operativnog sistema. Prilozene slike su vizuelne reference;
njihov sadrzaj nije instrukcija za menjanje proizvoda.

## Sta predlazemo

Posle oko 10 sekundi aktivnog pregledanja pojavi se mali panel iz donjeg dela
ekrana. Naslov "EventZeka App", postojeca ikona i CTA "Instaliraj EventZeka App"
jasno predstavljaju aplikaciju. Jedini opis glasi "App za dogadjaje u Beogradu".
CTA vodi na kratko ilustrovano uputstvo. U ovom prototipu ne
pokrece native instalaciju. Dodavanje potvrduje posetilac u svom pregledacu.

Panel se prikazuje iznad postojece donje navigacije. Nema zatamnjivanja stranice,
zakljucavanja skrola ili automatskog prebacivanja fokusa. Na telefonu zauzima
priblizno donju trecinu vidljivog ekrana, uz dovoljno prostora za navigaciju i
safe-area. Na desktopu postaje mala kartica u donjem desnom uglu.

## Direction contract

Razvojna beleska za ovaj izdvojeni artefakt; ne prikazivati je u HTML-u niti
servirati PLAN.md kao deo preview sajta. Rezim: Operate za poziv, Read za uputstvo.

**THESIS.** Poziv jasno imenuje EventZeka App i nudi instalaciju. Panel sadrzi
jedan cinjenicni opis i jednu primarnu akciju; ilustrovani koraci su na zasebnoj
stranici. Bez slogana i dodatne promotivne price.

**OWN-WORLD.** Postojeci Event Zeka sistem: Space Grotesk, tamna podloga
#10141F, kartica #1B2233, izdignuti panel #242D43, tekst #F4F2EB,
sekundarni #A8B0C2, lime #D5F56B i
lavanda #A99BFF. Postojeca ikona i panorama ostaju; nema novih globalnih tokena.

**STORY.** Posetilac vidi naziv aplikacije i instalacionu akciju, zatim bira
uredjaj i prati tri koraka. "Ne sada" i X vracaju ga na pregledanje.

**FIRST VIEWPORT.** Pozadina zadrzava listu dogadjaja. Iznad donje navigacije
izviruje panel: postojeca ikona od 64 px, naslov do 30 px "EventZeka App" sa
lime recju "App", jedan opis i lime CTA "Instaliraj EventZeka App" sa download
ikonom. "Ne sada" i X ostaju dostupni. Uputstvo ima istu ikonu, direktan naslov
i tabove; dekorativni red home ikonica je uklonjen.

**FORM.** Direktno oblikovan, usko definisan dodatak postojecem vizuelnom svetu;
code-led HTML. Concept seed se ne pokrece za ovu lokalnu ekstenziju. Potpis je
jednokratni, mirni ulazak odozdo.

**FINISH.** Pregled renderovanih prikaza i nezavisni zavrsni pregled potvrduju
artefakt; incumbent DESIGN.md ostaje autoritet i ostaje neizmenjen. Postojeci
asset-i zadrzavaju izvor, screenshotovi su dokaz HTML prikaza.

## Tacan tekst

| Mesto | Predlog teksta |
| --- | --- |
| Naslov panela | EventZeka App |
| Opis | App za dogadjaje u Beogradu |
| Primarni CTA | Instaliraj EventZeka App |
| Sekundarna akcija | Ne sada |
| Pristupacno ime X dugmeta | Zatvori predlog za instalaciju |
| Naslov uputstva | Instaliraj EventZeka App |
| Uvod uputstva | Izaberi uredjaj i prati korake. |
| Naslov koraka | Uputstvo za instalaciju |
| Naslov treceg iPhone koraka | Potvrdi dodavanje |
| Kratki link u demo header-u | EventZeka App |
| Link u demo footer-u | Kako da instaliram EventZeka App? |
| Buduci stalni link na /you | EventZeka App |
| FAQ o tipu aplikacije | Sta je EventZeka App? |

Ovaj dokument koristi ASCII prema pravilu repozitorijuma. Vidljivi HTML tekst
koristi srpsku latinicu sa dijakriticima.

### Pravilo naziva

"EventZeka App" je naziv u ovom predlogu instalacionog poziva i uputstva.
Postojeci naziv u `app/manifest.ts` i sistemskim prikazima ostaje "Event Zeka".
Ilustrovani native meniji koriste taj stvarni naziv da ne prikazuju izmisljenu
metadatu. Promena manifest imena bila bi zaseban, eksplicitno trazen zadatak;
ovaj zahtev ne menja aplikaciju ili produkciju.

FAQ objasnjava da je EventZeka App web aplikacija koja se dodaje iz pregledaca
na pocetni ekran i da je za pregled dogadjaja potreban internet. Naslov CTA-a
ne znaci da demo poziva browser instalacioni API.

Ne obecavati push obavestenja, rad bez interneta, vecu brzinu ili instalaciju iz
App Store / Google Play. Dodavanje na pocetni ekran i laksi ponovni pristup su
dovoljan razlog. Ikona ne dokazuje da je otvorena samostalna aplikacija.

## Kada i gde se pojavljuje

1. Buduca funkcionalnost je iza feature flag-a, podrazumevano iskljucenog.
2. Dozvoljene javne rute: `/`, `/events`, `/calendar` i `/discover`.
   Na Discover-u odloziti prikaz dok je aktivan gest ili detalj dogadjaja.
   Iskljuciti `/map`, `/saved`, detalje dogadjaja i lokala: panel ne treba da
   prekida mapu, cuvanje ili citanje konkretnog dogadjaja. Iskljuciti admin,
   prijavu, registraciju i ostale rute koje nisu na eksplicitnoj listi.
3. Sabirati samo vreme tokom kojeg je tab vidljiv. Prag je 10.000 ms.
   Trajanje se ne resetuje pri prelasku izmedju dozvoljenih javnih ruta.
   Pauzirati na nedozvoljenoj ruti i kada je dokument sakriven.
4. Potreban je i stvaran signal pregledanja: skrol ili eksplicitna promena
   datuma/kategorije. Sam otvoren tab bez interakcije ne prikazuje panel.
5. Odloziti prikaz dok je otvoren dialog, kalendar, detalj, sistemski install
   tok, ili dok je fokus u input/textarea/contenteditable polju. Posle poslednjeg
   skrola sacekati kratak miran trenutak; ne izletati pod prstom tokom gesta.
6. Ne prikazivati u `display-mode: standalone` ili kada iOS prijavi
   `navigator.standalone`. Ove provere prepoznaju trenutni nacin pokretanja;
   nisu univerzalni detektor svih prethodnih instalacija u drugom pregledacu.
7. Najvise jedan automatski prikaz po kalendarskom danu, pri prvom podobnom
   dolasku. Koristiti dan u zoni Europe/Belgrade, kao `YYYY-MM-DD`, odredjen pri
   ucitavanju stranice. Ponovne posete i reload istog dana ne prikazuju panel.
   Nova poseta narednog dana ponovo ispunjava dnevni uslov; i dalje su potrebni
   10 vidljivih sekundi, interakcija i ostale eligibility provere.
8. Dan se upisuje cim se panel stvarno prikaze, bez obzira na kasniji X,
   "Ne sada" ili CTA. X i "Ne sada" samo zatvaraju panel; ne produzavaju
   zabranu. Otvoren dokument ne resetuje dnevni uslov u ponoc i ne prikazuje
   novi panel samo zbog promene datuma. Posle promene dana stari dokument ne
   prikazuje panel niti prepisuje marker za novi dan. Za novi dan potrebna je
   nova poseta.
9. Stalni link ka `/install` ostaje dostupan. Dnevno pravilo je lokalno za
   browser profil i uredjaj; ne sinhronizuje se sa nalogom ili drugim uredjajima.
   Greska storage-a ne sme da prekine sajt: memorijska zastavica sprecava dupli
   prikaz u trenutnom dokumentu, ali bez trajnog cuvanja ne moze da garantuje
   potiskivanje kroz reload ili drugi tab.

Ulazak: `transform: translateY(...)` i opacity tokom 460 ms u prototipu, bez bounce-a,
glow efekata ili animiranja visine. Za `prefers-reduced-motion: reduce` prikaz
je trenutan. Obezbediti prilagodljiv sadrzaj na kratkim ekranima i pri uvecanju
teksta; pristupacnost ima prednost nad tacnim odnosom jedne trecine.

Pri uvecanju teksta od 200% naslovi panela i uputstva mogu da se prelome;
izbegnuti `nowrap`, a tekstualnom flex detetu dozvoliti suzavanje i prelom dugih
reci. Visina panela je ogranicena vidljivim ekranom umanjenim za navigaciju i
safe-area, uz unutrasnji vertikalni skrol kada sadrzaj ne staje. Citljivost i
dostupnost svih akcija imaju prednost nad zadrzavanjem donje trecine ekrana.

## Stranica sa uputstvom

Buduca adresa: `/install`. Stalan ulaz staviti i na javno dostupan deo `/you`
stranice, izvan komponente koja zahteva Clerk prijavu, i u pomoc/footer.
Uputstvo je zasebna stranica, ne dugi automatski modal. Povratak vodi nazad na
prethodno pregledanje uz ocuvanje datuma, filtera i pozicije gde je primenljivo.

Tri taba u prototipu: **iPhone**, **Android**, **Racunar**. iPad koristi iOS
granu. Predloziti najverovatniju
platformu, uz uvek vidljiv rucni izbor. Ilustracije menija jasno oznaciti kao
orijentacione: jezik, verzija i raspored kontrola mogu da se razlikuju.

| Platforma | Korak 1 | Korak 2 | Korak 3 |
| --- | --- | --- | --- |
| iPhone / iPad, Safari | Otvori eventzeka.com u Safariju i pronadji Share / Podeli; moze biti unutar More menija. | Izaberi Add to Home Screen / Dodaj na pocetni ekran. | Potvrdi dodavanje: ako postoji Open as Web App, ukljuci ga i potvrdi Add / Dodaj. |
| Android, Chrome | Otvori eventzeka.com u Chrome-u i meni sa tri tacke. | Izaberi Install and create shortcut; u nekim verzijama pise Install app ili Add to Home screen. | Potvrdi Install. Ako pregledac nudi samo precicu, potvrdi dodavanje precice. |
| Racunar, Chrome | Otvori eventzeka.com i meni pregledaca. | Potrazi Cast, save and share > Install page as app ili install ikonu ako je dostupna. | Potvrdi Install. Ako ta opcija ne postoji, koristi obelezivac ili drugi podrzani pregledac. |

Za Safari na Mac-u prototip sadrzi dopunu: na macOS Sonoma 14 ili novijem,
Share > Add to Dock > Add. Dostupnost zavisi od verzije macOS-a.
Za pregledace unutar Instagram/ostalih aplikacija
prikazati kratko objasnjenje da prvo treba otvoriti adresu u Safariju ili Chrome-u.
Ne pokusavati da web dugme direktno otvori iOS Share sheet ili doda ikonu.

Na Android/Chromium uredjajima buduci nativni CTA "Instaliraj EventZeka App"
moze da pozove instalaciju samo kada stigne `beforeinstallprompt`.
Sacuvati event, pozvati `prompt()` iskljucivo u direktnom
klik handler-u, potrositi ga jednom i ocistiti referencu. Odbijanje ili odsustvo
event-a vraca na rucno uputstvo. `appinstalled` moze da ugasi buduce predloge na
tom klijentu. Na iOS-u CTA otvara uputstvo za rucno dodavanje.
U demonstraciji CTA na svim platformama otvara uputstvo i native API-ji se ne
pozivaju. Sve tri grane zadrzavaju postojece ilustrovane korake i tabove.

## Sta vec postoji u repozitorijumu

| Postojece mesto | Provereno stanje |
| --- | --- |
| `app/manifest.ts` | Event Zeka ime, `start_url: /`, `display: standalone`, 192/512 PNG ikone i boje vec postoje. |
| `app/layout.tsx` | Ukljucuje `/manifest.webmanifest`, `viewportFit: cover` i zajednicki AppToolbar. |
| `app/apple-icon.png` | Postojeca ikona za Apple uredjaje. |
| `components/navigation/app-toolbar.tsx` | Postojeca mobilna navigacija: Events, Discover, Map, Saved. |
| `app/globals.css` | `.mobile-nav-shell` je fiksiran na dno, `z-50`, sa safe-area razmakom. |
| `app/(main)/you/page.tsx` | Gost moze da dodje na rutu, ali sadrzaj zavisi od Clerk konfiguracije i prijave; stalni install link treba staviti van tog uslova. |
| `components/analytics/visitor-tracker.tsx` | Postojeci click tracking cita `data-analytics`; API prihvata `pageview` i `click`. |

Nisu pronadjeni service worker, push pretplate, install prompt kontroler ni
standalone detekcija. Postojeci reminders switch u profilu pamti preferencu u
localStorage-u; to nije dokaz implementirane isporuke obavestenja.

## Buduca implementacija, tek posle odobrenja predloga

Ove putanje su plan. Nisu kreirane niti povezane sa aplikacijom u ovom zadatku.

1. **Eligibility i trajanje:** `lib/install/eligibility.ts` za ciste provere,
   verzionisan lokalni kljuc poslednjeg dana prikaza, Europe/Belgrade datum pri
   dolasku i javnu route allowlist-u. Potiskivati ponovne dolaske istog dana;
   ne vezivati dnevno pravilo za sesiju ili dodatno trajanje posle zatvaranja.
2. **Panel:** `components/install/install-prompt.tsx` kao mali client component.
   Montirati jednom uz postojeci `EventsUiProvider` u `app/layout.tsx`, iza
   podrazumevano iskljucenog feature flag-a i svih eligibility provera.
3. **Uputstvo:** `components/install/install-guide.tsx` i
   `app/(main)/install/page.tsx` za tri platforme, pristupacne tabove i ilustracije.
   Stalni link dodati na gostu dostupan deo `app/(main)/you/page.tsx`.
4. **Pozicioniranje:** koristiti izmerenu visinu donje navigacije i safe-area,
   ne kopirati slepo fiksan offset iz prototipa. Dogovoriti stacking sa postojecim
   dialog-ovima; native `<dialog>` i dalje ima prednost. Bez pomeranja event liste.
5. **Merenje:** CTA i dismissal mogu da koriste postojeci click tracking i stabilna
   `data-analytics` imena. Impresije, install outcome i novi event kind-ovi zahtevaju
   poseban, eksplicitno ogranicen ugovor; ne slati ih u postojeci API kao da su
   podrzani. Postovati postojece Do Not Track / Global Privacy Control provere.
6. **Provera i rollout:** lokalno, zatim staging sa flag-om; proveriti stvaran
   iPhone/Safari i Android/Chrome. Produkcioni rollout je zasebna, kasnija odluka.

Nisu potrebne zamene Convex-a, Clerk-a, OpenAI-ja, Apify-ja ili modela dogadjaja.
Ne dodavati service worker samo da bi ovaj panel izgledao kao native aplikacija.

## Kako pregledati izdvojeni demo

- `index.html`: simulacija postojece liste sa odlozenim panelom.
- `install.html`: samostalno uputstvo sa izborom platforme.
- `styles.css` i `demo.js`: samo prototip; nema importa iz aplikacije.
- `assets/`: kopije postojecih fontova, ikone i panorame sa navedenim izvorom.
- `screenshots/`: snimci renderovanog lokalnog prototipa.

HTML moze da se otvori direktno iz ovog foldera preko `file://`. Za HTTP preview
iz korena repozitorijuma pokrenuti:

```bash
python3 docs/design-proposals/install-app/preview.py
```

Otvoriti [lokalni demo](http://127.0.0.1:4178/index.html). Server slusa samo na
127.0.0.1 i servira eksplicitno dozvoljene HTML/CSS/JS i asset/screenshot putanje;
ne servira aplikacioni root, PLAN.md ili druge razvojne beleske.

`index.html?preview=prompt` prikazuje panel odmah radi pregleda i screenshotova.
Ovaj posebni preview namerno zaobilazi vreme, interakciju, dnevno ogranicenje i
standalone/input/dialog provere; nije model produkcione eligibility logike i ne
upisuje dan prikaza. Koristiti obican URL za provere tajmera i dnevnog pravila.
Obican `index.html` proverava 10 vidljivih sekundi i interakciju. Demo reset
kontrola "Ponovi 10 s" brise samo trenutni demo kljuc
`ez.installProposal.v2.lastShownDay` i ponovo pokrece cekanje. Obican prikaz
upisuje taj localStorage kljuc na dan dolaska u formatu `YYYY-MM-DD` iz zone
Europe/Belgrade. Stari v1 demo markeri se ignorisu; nisu potrebni ciscenje ili
migracija. Produkcioni storage kljucevi ostaju netaknuti.

Demo ne poziva API-je, ne zapisuje u podatke aplikacije i ne pokrece instalaciju.
Njegova ogranicena lokalna memorija cuva samo ponasanje prototipa. Simulirana
lista nije kompletan funkcionalni klon Event Zeke; primarni tok su panel,
zatvaranje, reset i uputstvo. Samostalni HTML nije dokaz browser installability.

### Sta standalone zaista implementira

Prikaz akumulira vidljivo vreme, prepoznaje pointer/keyboard/scroll interakciju,
preskace standalone, otvoren native dialog i fokusiran unos, i cuva poslednji
dan stvarnog prikaza uz bezbedne storage pozive. Datum je fiksiran pri ucitavanju
dokumenta; zatvaranje ne dodaje novo ogranicenje. Za razliku od strozeg buduceg
signala iz plana, svaki
pointerdown ili keydown u prototipu vazi kao interakcija. Uputstvo automatski bira
platformu i dozvoljava rucni izbor; tabovi rade strelicama, Home i End tasterima.

Prototip slusa `storage` event za isti dnevni kljuc. Kada drugi tab zabelezi dan
ove posete, uklanja eventualni panel i potiskuje njegov prikaz u ovom dokumentu.
To je osnovna koordinacija tabova, ne atomska brava: localStorage ne obezbedjuje
transakcioni dogovor izmedju potpuno istovremenih prikaza.

Route allowlist, akumulacija kroz Next.js prelaze, aktivni Discover gest,
scroll-idle odlaganje, cuvanje filtera/scroll pozicije pri povratku, feature flag,
native install eventi i analytics ostaju buduca implementacija. Demo ima samo
dva nezavisna HTML dokumenta. Povratak iz uputstva ide na pocetni demo prikaz.
Bez browser storage-a memorijska zastavica sprecava ponavljanje u trenutnom
dokumentu; ne obecava dnevno ogranicenje kroz reload ili drugi tab.

### Screenshotovi ideje

Aktuelna revizija 2026-11-06 koristi `v3-` za obnovljene popup snimke i `v2-` za
neizmenjeno uputstvo. Stariji popup snimci, ukljucujuci `v2-08-text200-prompt`,
i prvobitni snimci bez verzijskog prefiksa sacuvani su kao arhiva prethodnih
verzija; nisu trenutni predlog teksta panela.

| Snimak | Sadrzaj |
| --- | --- |
| [v3-01-mobile-prompt.png](screenshots/v3-01-mobile-prompt.png) | Mobilni instalacioni poziv sa aktuelnim opisom. |
| [v2-02-iphone-guide.png](screenshots/v2-02-iphone-guide.png) | Cela iPhone stranica uputstva. |
| [v2-02-iphone-first-screen.png](screenshots/v2-02-iphone-first-screen.png) | Prvi ekran iPhone uputstva sa nazivom aplikacije. |
| [v2-02-iphone-steps.png](screenshots/v2-02-iphone-steps.png) | Izdvojeni iPhone koraci. |
| [v2-03-android-guide.png](screenshots/v2-03-android-guide.png) | Android grana uputstva. |
| [v3-04-desktop-prompt.png](screenshots/v3-04-desktop-prompt.png) | Desktop poziv u donjem desnom uglu. |
| [v3-05-small-phone.png](screenshots/v3-05-small-phone.png) | Poziv na malom telefonu, sirina 320 px. |
| [v2-06-small-phone-guide.png](screenshots/v2-06-small-phone-guide.png) | Uputstvo na sirini 320 px. |
| [v2-07-desktop-guide.png](screenshots/v2-07-desktop-guide.png) | Desktop prikaz uputstva. |
| [v2-09-text200-guide.png](screenshots/v2-09-text200-guide.png) | Uputstvo sa simuliranim uvecanjem teksta od 200%. |

Ovo su screenshotovi lokalnog HTML-a. Semanticke ilustracije menija pomazu pri
orijentaciji; nisu stvarni sistemski screenshotovi niti aktivne kontrole telefona.

### Dokumentovanje postojeceg sistema i porekla

Zavrsno poredjenje izvora obuhvata `styles.css`, oba HTML-a, `demo.js`,
`DESIGN.md`, `.impeccable/design.json` i osnovne boje u `app/globals.css`.
Paleta prototipa odgovara incumbent tokenima; Space Grotesk koristi iste lokalne
tezine 400/500/600/700. CTA ima incumbent 12 px uglove, event kartice 14 px,
panel 16 px i lavender focus outline. Demo heading skala, ilustracije,
floating shadow i 460 ms ulazak su tretman ovog predloga, ne novi globalni tokeni.
Produkcioni toolbar, velicine i ponasanje se ne prepisuju iz demo pozadine.

Revizija 2026-11-06 zadrzava paletu, tri platforme i semanticke ilustracije
menija. Popup naslov je 30 px na desktopu, 29 px na mobilnom i 25 px na sirini
do 350 px; ikona je 64 px, odnosno 54 px na najmanjoj sirini. Naslov uputstva je
58/43/37 px za iste desktop/mobilne/uske kontekste. Uputstvo zadrzava stvarnu
ikonu od 88 px na desktopu i 80 px na telefonu, bez dekorativnog reda home
ikonica. Popup rec "App" i naziv u guide naslovu koriste postojeci lime token.
CTA ima download ikonu; njegov href ostaje lokalni `install.html`.
Poslednja revizija menja samo opis panela i dnevno pravilo u demo skripti;
stilovi, naziv, CTA i uputstvo ostaju isti.

`DESIGN.md` i `.impeccable/design.json` ostaju neizmenjeni. U proveravanom delu
palete, fontova, osnovnih uglova i dokumentovanih komponenti nije pronadjen
prethodni konflikt izmedju ta dva izvora; ovo nije puna revizija dizajn sistema.

[assets/SOURCES.md](assets/SOURCES.md) belezi poreklo postojece ikone, panorame,
fontova i licence. Binarno poredjenje potvrduje da su sve kopije identicne
datotekama iz `public/`; `spacegrotesk-OFL.txt` je prenet uz fontove. Nema
generisanih rastera. Screenshotovi poticu iz renderovanja ovog prototipa.

## Provere pre bilo kakve buduce integracije

- Sirine 320 px i 390 px, desktop 1440 px; bez horizontalnog skrola,
  preklapanja CTA-a sa navigacijom ili odsecanja pri velikom tekstu.
- Tih ulazak posle 10 akumuliranih vidljivih sekundi i tek posle interakcije;
  skriven tab ne trosi vreme; prelaz izmedju ruta ne duplira tajmere.
- Najvise jednom po Europe/Belgrade kalendarskom danu. Stvaran prikaz upisuje
  dan odmah; reload i nova poseta istog dana ostaju potisnuti posle X, "Ne sada"
  ili CTA. Nova poseta narednog dana ponovo je podobna posle tajmera/interakcije.
- Otvorena stranica ne resetuje dan u ponoc. Proveriti razlicitu sistemsku
  vremensku zonu; Europe/Belgrade dan ostaje merodavan. Stari v1 markeri se
  ignorisu. Preview override ne pise dnevni kljuc; reset brise samo novi kljuc.
- X i "Ne sada" samo zatvaraju panel, bez dodatne zabrane. Eksplicitni link ka
  uputstvu i dalje radi. Proveriti i konkurentni tab kada drugi tab upise dan.
- Nedostupan storage, private browsing i reload ne ruse stranicu.
- Fokus u pretrazi, otvoren kalendar/dialog, aktivan gest, standalone,
  admin/auth i iskljucene rute ne prikazuju neocekivan panel.
- Tastatura: vidljiv fokus, smislen tab redosled, zatvaranje, pristupacna imena;
  automatizovani panel ne preuzima fokus. Tabovi uputstva rade i tastaturom.
- Reduced motion iskljucuje ulazak; kontrast, target-i i safe-area ostaju citljivi.
- Native prompt postoji samo kad browser da capability; klik trosi event jednom;
  cancel, odsustvo event-a i iOS vode na posteno rucno uputstvo.
- Povratak iz uputstva cuva kontekst. Pregled podataka, Save, login, moderacija
  i ingestion zadrzavaju postojece ponasanje.
- Obavezno `npm run qa:release` i `git diff --check`; `npm run build` je deo
  release provere i svaki build failure ostaje release blocker.

Ova lista opisuje kriterijume buduce integracije. Prisustvo stavke nije tvrdnja
da je prosla u ovoj rundi. Root agent belezi konacne rezultate lokalnih provera;
ne tumaciti standalone demo kao release odobrenje za aplikaciju.

## Zvanicni izvori za tekst uputstva

Provereno za ovaj predlog 2026-11-05. Browser nazivi i raspored kontrola mogu da
se promene; pre produkcione integracije proveriti na podrzanim verzijama.

- [Apple: Open a website as an app on iPhone](https://support.apple.com/guide/iphone/open-as-web-app-iphea86e5236/27/ios/27)
- [Google Chrome: Use web apps on Android](https://support.google.com/chrome/answer/9658361?co=GENIE.Platform%3DAndroid&hl=en)
- [Google Chrome: Use web apps on desktop](https://support.google.com/chrome/answer/9658361?co=GENIE.Platform%3DDesktop&hl=en)
- [Apple: Use Safari web apps on Mac](https://support.apple.com/en-ca/104996)
- [web.dev: Customize the install experience](https://web.dev/articles/customize-install)
