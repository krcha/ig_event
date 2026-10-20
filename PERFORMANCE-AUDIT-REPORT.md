# Event Zeka: provera performansi i objavljena verzija

Naknadna izmena Open now pravila i zahtev za jednom produkcijom/jednim backup-om
opisani su u [posebnoj belesci](</Users/krcha/.codex/worktrees/public-day-loading/eventzeka-seo/docs/open-now-nightlife-2026-10-21.md>).
Brojevi i build identiteti ispod pripadaju prethodnoj perf objavi i predstavljaju
istorijski zapis njenih merenja.

Azurirano 2026-10-21, Europe/Belgrade. Zavrsna web verzija objavljena je na
[eventzeka.com](https://eventzeka.com): commit
`1e69ed000b66f52386916aa9003358aac4683833`, build `pyj4NSlpNt9-6Z1pSQAgR`.
Potvrdjeni su build glavne stranice i mape, ispravnost servisa i rutiranje.
Zavrsena su ponovljena javna merenja i provere slajdera na oba uredjaja.
Sira provera nije u celini prosla: povremena React #418 greska i jedan zastoj
klika ostaju nereseni. Izvorni neuspesni rezultati sacuvani su uz uspesne provere.

## Tehnologije i obuhvat

Next.js 15.5.20 App Router, React 19.2.7, TypeScript i Tailwind CSS 4; serversko
citanje preko HTTP-a iz self-hosted Convex 1.31.7; Clerk autentifikacija;
dinamicki ucitana Leaflet mapa. Web aplikaciju izvrsava Node 22 u Docker-u,
iza Traefik-a. OpenAI i Apify sluze za unos sadrzaja i nisu na putanji prikaza
javnih stranica.

Objavljena verzija cuva postojeci dizajn sa pet kategorija, kontrole mape,
zelenu oznaku "Open now", postojece granice datuma za nocne dogadjaje, unos i
moderaciju. Svih 261 prethodnih backend modula ostalo je identicno na nivou
bajtova. Dodata su dva adaptera za citanje; schema, autentifikacija, definicije,
indeksi i cron zadaci nisu menjani. Pri objavi je preko aktivnog serverskog
izvornog koda kopirano 22 izricito pregledanih putanja. Sacuvani su konfiguracija
izvrsavanja i nezavisno rutiranje drustvenih pregleda.

## Problemi po prioritetu

### 1. P1 - Traka datuma je ponovo ucitavala stranicu i prolazila od prvog dana: ispravljeno

**Gde:** [traka datuma](</Users/krcha/.codex/worktrees/e061/eventzeka-seo/components/calendar/mobile-month-day-strip.tsx>)
i [povratna informacija pri navigaciji](</Users/krcha/.codex/worktrees/e061/eventzeka-seo/components/navigation/navigation-feedback.tsx>).

**Dokaz i uzrok:** Globalni handler u capture fazi pretvarao je linkove sa istom
putanjom i razlicitim query parametrima u navigaciju koja ucitava ceo dokument.
CSS `scroll-smooth` uticao je i na pocetno programsko pozicioniranje. Klikovi
na javnom sajtu, na racunaru i mobilnom, slali su jedan zahtev za dokument,
vracali traku na nulu i animirali prolazak kroz datume. Ranija lokalna ispravka
nije bila objavljena, pa je korisnik na javnom sajtu i dalje video isto ponasanje.

**Izmena:** Kontrolisana klijentska navigacija za linkove datuma; trenutno pocetno
pozicioniranje; pamcenje horizontalnog polozaja po mesecu i prikazu; skrolovanje
ograniceno na samu traku i podrska za smanjeno kretanje. Prefetch ostaje iskljucen.

**Uticaj, slozenost i rizik:** Direktno uklanja prijavljenu gresku u interakciji;
mala/srednja slozenost, nizak rizik. Zavrsna javna verzija prosla je 66 provera
slajdera na oba uredjaja; privatni pregled prosao je 68 provera. Zahtevi pri prelasku na
sledeci datum promenjeni su sa jednog dokumenta/nula RSC na nula dokumenata/jedan
RSC. Obnova polozaja nakon ponovnog ucitavanja bila je tacna: mobilni
957 -> 957 px, racunar 560 -> 560 px; bez vertikalnog skoka ili prolaska kroz datume.

**Provera pre i posle:** Isti Chromium, dimenzije prikaza i redosled datuma;
snimiti zahteve za dokument/RSC i polozaj `scrollLeft` kroz frejmove. Proveriti
ponovno ucitavanje, nazad/napred i navigaciju tastaturom.

### 2. P1 - Glavna stranica je preuzimala detalje celog meseca za prikaz jednog dana: ispravljeno

**Gde:** [stranica kalendara](</Users/krcha/.codex/worktrees/e061/eventzeka-seo/app/(main)/events-browse-page.tsx>),
[ucitavanje sazetka](</Users/krcha/.codex/worktrees/e061/eventzeka-seo/lib/events/public-calendar-overview.ts>)
i [action za citanje](</Users/krcha/.codex/worktrees/e061/eventzeka-seo/convex/publicCalendarOverviewAction.ts>).

**Dokaz i uzrok:** U oktobru je bilo 478 javnih dogadjaja. Prethodni prikaz
preuzimao je deset uzastopnih stranica dogadjaja i dve grupe podataka o mestima,
iako je izabrani dan imao 37 dogadjaja. Vecina sadrzaja i radnog vremena nije
bila potrebna za aktivni dnevni prikaz.

**Izmena:** Izabrani datum odredjuje se pre preuzimanja detalja. Ucitavaju se
detalji tog dana; detalji drugog dana preuzimaju se posle navigacije. Oznake dana,
pretraga i izbor mesta koriste sazete brojace. "Open now" zadrzava prethodni
kalendarski dan kada je potreban zbog dogadjaja posle ponoci. Broj za izabrani
dan koristi isti snimak detalja kao vidljive kartice. Zadrzani su postojeci rok
kesa od 60 sekundi, objedinjavanje istovremenih zahteva, uklanjanje neuspelih
obecanja iz kesa i postojece provere objave i kursora.

**Uticaj, slozenost i rizik:** Stvarna JSON tela odgovora izmedju backend-a i
Next-a smanjena su sa 548,709 na 190,486 bajtova, uz identicne digeste sadrzaja;
broj dogadjaja cije detalje prima Next smanjen je sa 478 na 37. Srednja slozenost,
nizak/srednji rizik. Time se smanjuju prenos i parsiranje; ovo ne dokazuje
univerzalno smanjenje kasnjenja ili broja citanja baze.

**Provera pre i posle:** Ponoviti iste argumente za mesec, dan, pretragu i mesto
na obe kombinacije poziva; uporediti digeste dogadjaja, brojace, zavrsetak
paginacije, bajtove i vreme do vidljivog sadrzaja. Obuhvatiti prazne dane,
granice meseca i "Open now" posle ponoci.

### 3. P1 - Mapa je preuzimala nedeljne detalje i ceo imenik mesta: ispravljeno

**Gde:** [stranica mape](</Users/krcha/.codex/worktrees/e061/eventzeka-seo/app/(main)/map/page.tsx>)
i [dopuna podataka za mapu](</Users/krcha/.codex/worktrees/e061/eventzeka-seo/lib/events/event-map.ts>).

**Dokaz i uzrok:** Prethodna mapa za izabrani dan ucitavala je detalje 342
nedeljna dogadjaja, podatke o njihovim mestima i zaseban imenik od 678 mesta.
Prikazivala je 37 dogadjaja.

**Izmena:** Detalji izabranog dana i sazeti nedeljni brojaci; dva kalendarska
dana ucitavaju se za nocni "Open now". Uklonjen je zahtev za ceo imenik.
Tacni, aktuelni ID-jevi mesta i dalje daju koordinate i radno vreme; pregledane
adrese primenjuju se kada se poklapaju ID i aktuelne koordinate. Zadrzana je
granica 06:00 za prikaz datuma nocnih dogadjaja na mapi.

**Uticaj, slozenost i rizik:** Stvarna JSON tela odgovora izmedju backend-a i
Next-a smanjena su sa 1,145,709 na 161,549 bajtova; broj odgovora 10 -> 9;
zapisi celog imenika 678 -> 0. Pregled verzije zadrzao je istih 37 kartica
dogadjaja i 33 oznake markera, ukljucujuci otvaranje pripadajuce liste izvodjaca
preko markera posle promene datuma. Srednja slozenost, nizak rizik uz provere
identiteta i nocnih dogadjaja. Ovi bajtovi nisu velicina preuzimanja u pregledacu
niti procenat poboljsanja LCP-a.

**Provera pre i posle:** Isti izabrani datum i skup podataka; uporediti ID-jeve
kartica, oznake markera, koordinate, kontrole datuma i "Open now". Odvojeno
meriti prikaz podataka, upotrebljive markere i vidljive plocice mape, uz TTFB/LCP
pocetnog dela stranice koji stize tokom streaminga.

### 4. P1 - Posteri u originalnoj velicini cine veliki deo nekih mobilnih preuzimanja: predlog

**Gde:** Discover, detalj dogadjaja i posteri mesta; zasticena izvorna ruta
`/api/discover/images/[eventId]` i `unoptimized` Image komponente.

**Dokaz i uzrok:** Jedna mobilna Discover slika prenela je 3,123,076 bajtova pri
sirini 2160 px, a prikazana je na 364 px. Posteri na detaljima dogadjaja i mesta
takodje su znatno veci od prikaza. Sam `sizes` ne menja velicinu `unoptimized`
slika. Slike koje se odlozeno ucitavaju mogu zavrsiti prenos van pocetnog
perioda posmatranja.

**Predlog:** Ogranicen skup prilagodljivih raster/WebP sirina iza postojece
zasticene izvorne putanje, sa revizijom izvora u kljucu kesa. Sacuvati listu
dozvoljenih hostova, provere objave, ogranicenja streaminga, SVG/animacije i
rezervni prikaz kada izvor nedostaje.

**Uticaj, slozenost i rizik:** Veliki potencijal za smanjenje prenosa i LCP-a;
srednja slozenost i rizik zbog citljivosti teksta na posterima, procesorskog
troska transformacije i azurnosti. U ovoj objavi nisu menjani kvalitet slika
ni rok njihovog kesiranja.

**Provera pre i posle:** Fiksirati reprezentativne postere; uporediti bajtove i
TTFB prve/ponovljene posete pri DPR 1/2/3, vizuelno pregledati sitan tekst i
proveriti neispravne/animirane izvore i istovremene transformacije pre objave.

### 5. P2 - Neiskoriscen zajednicki JavaScript i ponovljeno racunanje vremena: ispravljeno

**Gde:** [korenski layout](</Users/krcha/.codex/worktrees/e061/eventzeka-seo/app/layout.tsx>)
i priprema prikaza vremena u okviru istog zahteva kalendara.

**Dokaz i uzrok:** Korenski layout ucitavao je Convex React provider-e iako
nijedna komponenta ne koristi njihove hook-ove. Javni podaci i biblioteka
koriste serverske HTTP API-je. Oznake kalendara vise puta su racunale isti
prikaz vremena za svaki dogadjaj.

**Izmena:** Uklonjeni su neiskoriscen korenski omotac i import; sacuvani su
Convex, Clerk i API-ji biblioteke. Prikaz vremena racuna se jednom po dogadjaju
u okviru istog zahteva.

**Uticaj, slozenost i rizik:** Mala slozenost i nizak rizik. Stvarni zbir
jedinstvenih pocetnih JS paketa glavne stranice u Linux build-u:
652,608 -> 585,253 sirovih bajtova, 13 -> 12 paketa; procenjeni gzip
194,957 -> 175,896 bajtova. Mapa: 666,872 -> 599,393 sirovih bajtova.
Gzip procene nisu izmereno vreme prenosa ili parsiranja i ne ukljucuju spoljni
Clerk ni asinhroni Leaflet. Racunanje za aktivnih 37 dogadjaja smanjeno je sa
148 na 37 poziva uz jednak izlaz; medijana izolovanog CPU merenja
22.038 -> 6.448 ms, sto nije vreme prikaza stranice.

**Provera pre i posle:** Uporediti manifeste produkcionog build-a i jednakost
prikaza vremena; proveriti poziv za prijavu, cuvanje dogadjaja/biblioteku i greske
u pregledacu. Nije bila dostupna prava prijavljena Clerk sesija, pa upis sacuvanog
dogadjaja nije potvrdjen kroz ceo korisnicki tok.

### 6. P2 - Prvi pristup novom opsegu datuma i dalje je skup: sledeci predlog

**Gde:** Postojeci paginirani javni upiti i action za sazetak; prikaz mape
trenutno ceka nedeljne brojace uz detalje izabranog dana.

**Dokaz:** Prototip sa upitom unutar upita trajao je 17,067 ms za nov,
ekvivalentan kljuc filtera i nije pusten u javni interfejs. Objavljeni action
moze da koristi postojeci kes javnih upita: nov ekvivalentan filter trajao je
468 ms, a zatim 424 ms. Zaista nov opseg datuma i dalje je trajao 5,279 ms
prvi put i 499 ms pri ponavljanju. Kod zagrejanog kesa zbirno vreme API poziva
za glavnu stranicu bilo je vece od prethodne kombinacije u dva uzorka.

Razliku potvrdjuje izvorni kod revizije backend-a koja radi na serveru:
[putanja kesa za action](https://github.com/convex/convex-backend/blob/9c73f185d0f698eaefce0ee82af6f245674bc6d1/crates/application/src/application_function_runner/mod.rs#L1985)
i [putanja ugnjezdenog izvrsavanja](https://github.com/convex/convex-backend/blob/9c73f185d0f698eaefce0ee82af6f245674bc6d1/crates/isolate/src/environment/udf/async_syscall.rs#L624).
Podupiti action-a imaju zasebne snimke podataka, kao i prethodni loader sa vise
zahteva. Svaki i dalje sprovodi svoje provere objave, zivotnog ciklusa i kursora.

**Predlog:** Poslati upotrebljivu mapu kroz streaming pre zavrsetka nedeljnih
brojaca ili obraditi ogranicen broj dozvoljenih stranica u jednom action-u i
ukloniti ponovljena citanja mesta izmedju tih stranica. Sacuvati neprozirni
kursor nastavka, tacne brojace, ogranicenja memorije/vremena i postojeci rok
azurnosti. Odrzavana tabela sazetaka bila bi poseban, veci zahvat sa izricitim
planom azuriranja i invalidacije.

**Uticaj, slozenost i rizik:** Potencijalno veliki uticaj na prvu posetu;
srednja slozenost i rizik. Ove dodatne izmene nisu implementirane ni obecane.

**Provera pre i posle:** Naizmenicno meriti prve/ponovljene pristupe opsezima,
ukljucujuci nove kljuceve podupita; odvojiti bajtove odgovora, CPU/kes backend-a
i stvarnu spremnost mape. Ne prazniti produkcioni kes niti iz zagrejanih citanja
izvoditi uzrocni procenat ubrzanja.

### 7. P2 - Kartice imenika i dalje dobijaju neiskorisceno radno vreme: predlog

**Gde:** Ucitavanje javnog imenika mesta i `venues:listPublicVenueFields`.

**Dokaz i uzrok:** 678 zapisa proizvelo je 704,565 JSON bajtova; polja radnog
vremena na 295 mesta cinila su 476,483 bajta serijalizovanih nizova polja.
Karticama imenika ti podaci nisu potrebni. Uklanjanje ovog poziva sa mape ne
ubrzava samu stranicu imenika.

**Predlog, uticaj i rizik:** Dodati javnu projekciju namenjenu imeniku sa tacnim
poljima potrebnim za kartice i pretragu; zadrzati radno vreme na detaljima i
putanjama "Open now". Srednji uticaj na prenos, mala/srednja slozenost, nizak
rizik uz provere ugovora podataka. Offline kompaktni DTO izmeren je na
162,537 bajtova; to je velicina predloga, a ne objavljena usteda.

**Provera pre i posle:** Isti ID-jevi/redosled mesta, oznake, kategorije, pretraga,
paginacija i lokacijska polja; uporediti stvarne bajtove odgovora i TTFB imenika.

### 8. P2 - Drugi filteri i navigacija i dalje ucitavaju ceo dokument: ogranicen predlog

**Gde:** Globalna povratna informacija pri navigaciji i izvorni linkovi alatki/filtera.

**Dokaz i uzrok:** Navigacija kroz ceo dokument uvedena je kao svesno zaobilazenje
ranijih zastoja App Router-a. Za linkove trake datuma sada postoji provereni
izuzetak. Globalno ukljucivanje klijentske navigacije ili prefetch-a vratilo bi
rizik koji nije izmeren.

**Predlog, uticaj i rizik:** Prosirivati kontrolisanu navigaciju po rutama nakon
merenja njihovog serverskog rada, uz zadrzavanje oznake cekanja, obnove
skrola/fokusa i rezervnog prelaska preko celog dokumenta pri problemu.
Potencijalno veliki uticaj na osecaj brzine; srednja slozenost i rizik.
Zajednicki markup mobilnog i desktop prikaza jos je jedan kandidat zasnovan
na izmerenoj velicini HTML-a, ali njegovo objedinjavanje trazi vizuelnu proveru
i proveru pristupacnosti.

**Provera pre i posle:** Isti brzi nizovi pretrage/filtera/nazad; brojati
dokumente/RSC, meriti vreme od klika do vidljivog rezultata i potvrditi ponasanje
tastature/fokusa i azurnost podataka.

### 9. P2 - Povremeni oporavak od greske hidratacije ostaje neresen

**Gde:** Mobilna navigacija "Previous day" i povratak dugmetom nazad iz anonimne
prijave na detalj dogadjaja u produkciji; granice hidratacije korena/provider-a/kalendara.

**Dokaz:** Sira zavrsna javna provera zabelezila je dve React #418 greske
hidratacije od kojih se aplikacija oporavila. Brojevi i kasnije interakcije ostali
su tacni. Ranije pocetne provere takodje su povremeno belezile #418; to ne
dokazuje da je ista komponenta izazvala svaku pojavu. Zavrsna stroga provera
slajdera prosla je 66 tvrdnji bez gresaka, dok je neuspesni artefakt sire provere
sacuvan. Ponovljena merenja dodala su jos jednu #418 pojavu na mobilnom detalju
dogadjaja pri ponovnoj poseti. U toj konkretnoj matrici pocetna verzija nije
imala greske. Ograniceno poredjenje istih tokova na starom/novom build-u nije
ponovilo #418, pa uzrok i status regresije nisu utvrdjeni. U jednom dodatnom
fokusiranom toku istekao je rok za klik kategorije; kasnija pretraga/kategorije
su radile, bez JS/HTTP greske. Ni taj zastoj nema dokazano objasnjenje.

Neposredna provera boje "Open now" uhvatila je CSS prelaz; oba build-a posle
900 ms imaju tacnu zelenu boju. To je vremenski pogresno postavljena tvrdnja
provere, dok su stvarne React greske i zastoj klika zadrzani kao nalazi.

**Predlog, uticaj i rizik:** Zabeleziti React stek komponenti i ponoviti isto
stanje/navigaciju na starom i novom build-u pre promene markup-a. Pregled koda
nije dokazao neispravan HTML, pocetni markup izveden iz storage-a ni klijentsko
ponovno racunanje datuma. DOM upisi pri montiranju kalendara moguci su kandidat
za trku, ali ne objasnjavaju pojavu na detalju dogadjaja. Ispravljati dokazano
nepoklapanje; naslepa promena provider-a ili hidratacije ima srednji rizik.
Oporavak moze dodati posao klijentskog prikaza, ali njegov uticaj na CPU/vreme
stranice nije izmeren.

**Provera pre i posle:** Ogranicen broj starih/novih izvrsavanja sa istom temom,
kategorijama, autentifikacijom i storage stanjem, ukljucujuci "Previous day" i
Sacuvaj -> prijava -> nazad. Sacuvati izvorne neuspehe, argumente gresaka/stekove
komponenti i identitet build-a; kasniji uspesan pokusaj ne ponistava greske.
Nije objavljena spekulativna ispravka hidratacije.

## Isporuka, kesiranje i ogranicenja dokaza

- Javni HTML/JS/CSS koriste gzip; resursi sa hash-om vec imaju jednogodisnje
  `immutable` zaglavlje kesa. Prisutan je HTTP/2. Nema dokaza koji opravdava
  zamenu proxy-ja/CDN-a.
- Zajednicki stylesheet blokira prikaz (104,080 sirovih / 17,004 gzip bajtova u
  prvobitnom uzorku). Sistemski fontovi izbegavaju veliki lanac web fontova;
  font od 2 MB za drustvene preglede koristi se na serveru. Nije pronadjen
  poseban lanac video/analytics/iframe resursa.
- Spoljni Clerk i plocice mape ostaju stvarni troskovi. Uzorci i zagrejanost
  njihovog kesa variraju. Uklanjanje neiskoriscenog provider-a ne uklanja Clerk
  i ne predstavlja dokaz ustede WebSocket saobracaja.
- Postojeca javna citanja koriste status/datum ili objava/datum indekse sa
  ogranicenim kursorima. Nije ustanovljen opsti problem nedostajuceg indeksa ili
  neogranicenog `collect` poziva. Nema merenja CPU-a baze ni terenskog INP/CrUX-a.
- Next kes i dalje traje 60 sekundi od uspesnog zavrsetka, sa najvise 48 zapisa,
  objedinjavanjem zahteva u toku i uklanjanjem neuspelih obecanja. Nije dodata
  sira politika zastarelog HTML-a/podataka. Osnovni upiti i dalje citaju dozvoljene
  mesecne/nedeljne redove za brojace; ne tvrdi se smanjenje broja citanja baze.
- Lokalni izvorni kod prosao je `npm run qa:release` (126 provera, ukljucujuci
  production build) i `git diff --check`. Prosli su i zasebni Linux
  lint/typecheck/build. Stari staticki resursi i prethodni web kontejner ostaju
  dostupni za kontrolisan povratak verzije.

## Izmereno pre i posle i ponavljanje provere

Poredjenje javnog API-ja koristilo je identicne argumente za oktobar/mesec/nedelju/dan,
`identity` enkodiranje i poklopljene digeste sadrzaja: 478 dogadjaja u mesecu /
342 u nedelji / 37 izabranog dana. Bajtovi obuhvataju telo HTTP JSON odgovora i
Convex omotac, bez HTTP/TLS zaglavlja; rec je o prenosu izmedju backend-a i Next-a.

| Merenje | Pre | Posle |
| --- | ---: | ---: |
| Glavna stranica: dogadjaji sa detaljima | 478 | 37 |
| Glavna stranica: HTTP JSON bajtovi | 548,709 | 190,486 |
| Mapa: dogadjaji sa detaljima | 342 | 37 |
| Mapa: HTTP JSON bajtovi | 1,145,709 | 161,549 |
| Mapa: mesta iz celog imenika | 678 | 0 |

Merenje u javnom sajtu koristi istu neizmenjenu Chromium skriptu, tri izvrsavanja,
prvu/ponovljenu posetu pregledaca, desktop 1440x900 i mobilni 390x844. Desktop:
CPU1 / 20 ms / 10 Mbit; mobilni: CPU4 / 150 ms / 1.6 Mbit; DPR1 i fiksnih
1.8 sekundi posmatranja nakon ucitavanja. Posebne provere mape cekaju upotrebljive
markere i plocice. Serverski kes se ne prazni; prva poseta znaci nov pregledac,
a ne hladan backend. Opterecenje zajednicke radne stanice bilo je visoko
(47.7-82.0 pre, 3.15-5.20 posle izmene, na osam logickih CPU-a), pa posmatrane razlike vremena
ne dokazuju univerzalno uzrocno ubrzanje. Ranije lokalne provere bile su jos
opterecenije i zadrzane su kao istorija.

- [Javni API dokazi i komande za ponavljanje citanja](</Users/krcha/.codex/worktrees/e061/eventzeka-seo/.seo-cache/performance/public-release/README.md>)
- [Tacan sazetak dokaza](</Users/krcha/.codex/worktrees/e061/eventzeka-seo/.seo-cache/performance/public-release/evidence.json>)
- [Stvarni zbirovi jedinstvenih Linux JS paketa](</Users/krcha/.codex/worktrees/e061/eventzeka-seo/.seo-cache/performance/public-release/bundles-linux.json>)
- [Potpuna prvobitna analiza, istorija i odbaceni kandidat](</Users/krcha/.codex/worktrees/e061/eventzeka-seo/PERFORMANCE-AUDIT-HISTORY.md>)
- [Postupak objave](</Users/krcha/.codex/worktrees/e061/eventzeka-seo/docs/performance-calendar-release-2026-10-20.md>)

## Zavrsna javna merenja i provere

Pocetni javni build: `JDyq4K6y63yk6TwoPpyil` (`85a1342`); zavrsni:
`pyj4NSlpNt9-6Z1pSQAgR` (`1e69ed0`). Svih 72 navigacija (36 pre + 36 posle)
vratilo je HTTP 200 i ocekivani build. Identiteti dogadjaja, datumi i naslovi
poklapaju se u svih 12 grupa. Skripta nije menjana izmedju faza; SHA-256:
`49048489369cdd07dcbf50ac9548d0a7912dbaea06808303f13bb231a091daa6`.

Slede medijane tri uzorka u milisekundama. To su posmatrane razlike, uz gore
navedenu razliku u CPU opterecenju, internet vezi i serverskom/spoljnom kesu.
LCP mape moze oznacavati shell/spinner; stvarna spremnost mape meri se zasebno.

| Uredjaj | Stranica | Poseta | TTFB pre -> posle (ms) | LCP pre -> posle (ms) |
| --- | --- | --- | ---: | ---: |
| Racunar | Glavna | Prva | 290 -> 137 | 1372 -> 792 |
| Racunar | Glavna | Ponovna | 247 -> 127 | 688 -> 268 |
| Racunar | Mapa | Prva | 124 -> 106 | 2588 -> 1380 |
| Racunar | Mapa | Ponovna | 402 -> 129 | 4772 -> 564 |
| Racunar | Detalj dogadjaja | Prva | 153 -> 144 | 1080 -> 676 |
| Racunar | Detalj dogadjaja | Ponovna | 80 -> 147 | 532 -> 260 |
| Mobilni | Glavna | Prva | 350 -> 342 | 2672 -> 1856 |
| Mobilni | Glavna | Ponovna | 195 -> 114 | 552 -> 280 |
| Mobilni | Mapa | Prva | 72 -> 81 | 1792 -> 1584 |
| Mobilni | Mapa | Ponovna | 62 -> 94 | 2524 -> 2104 |
| Mobilni | Detalj dogadjaja | Prva | 126 -> 130 | 1724 -> 1244 |
| Mobilni | Detalj dogadjaja | Ponovna | 83 -> 78 | 380 -> 260 |

U fiksnom periodu posmatranja, medijana prenetih bajtova za prvu glavnu stranicu
bila je 631,386 -> 612,204 na racunaru i 627,948 -> 612,168 na mobilnom.
Ovo ukljucuje spoljni Clerk i razlikuje se od backend-to-Next JSON-a iz gornje
tabele. Kasnije/lazy resurse ne treba tumaciti kao zavrsene u ovom periodu.
Sirovi rezultati sadrze raspon za svaku metriku, resurse, greske i CPU opterecenje.

Posebno merenje mape: tri nove posete po uredjaju pre i posle; bez presretanja
zahteva ili test podataka. Svaki uzorak zadrzao je 37 kartica i 33 markera,
bez browser gresaka. Vremena su od pocetka navigacije; u zagradama je min-max.

| Uredjaj | Stanje mape | Pre, medijana (raspon ms) | Posle, medijana (raspon ms) |
| --- | --- | ---: | ---: |
| Racunar | Podaci vidljivi | 3118 (1950-7832) | 694 (620-777) |
| Racunar | Markeri upotrebljivi | 3845 (2771-8201) | 970 (945-1077) |
| Racunar | Vidljive plocice ucitane | 4633 (3501-9016) | 1650 (1607-1657) |
| Mobilni | Podaci vidljivi | 1801 (1641-2639) | 1579 (1509-1858) |
| Mobilni | Markeri upotrebljivi | 4232 (3800-4900) | 3273 (3268-4105) |
| Mobilni | Vidljive plocice ucitane | 5882 (5751-6536) | 5129 (5126-5735) |

Ova zasebna provera imala je load1 4.50-10.67 pre i 3.21-3.42 posle, a ne
opterecenje matrice navigacija. Broj uzoraka je mali, provere su uzastopne i
serverski kes nije resetovan. Nije utvrdjen univerzalni procenat ubrzanja.

Provere interakcija potvrdile su cuvanje polozaja slajdera, prelazak datuma bez
document reload-a, nazad/napred, tastaturu, tacne brojace, pretragu bez rezultata,
promenu datuma mape i aktiviranje tacnog programa preko markera. Anonimno
cuvanje vodi na prijavu. Nema provere upisa sacuvanog dogadjaja sa stvarnom
prijavljenom Clerk sesijom. Opsti rezultat sire provere ostaje neuspesan zbog
nalaza iz tacke 9; nije napravljen objedinjeni dokaz da je sve proslo.

Zavrsni read-only deployment guard potvrdio je nepromenjen backend i zasticeni
runtime, uz zdrave javne `/` i `/map` sa zavrsnim build-om. Prethodna verzija i
privatni pregled zadrzani su za kontrolisan povratak; nisu gaseni mimo browser
uslova za zavrsnu proveru. Postojece backend funkcije, cron, unos i moderacija
ostali su nepromenjeni.

- [Javne browser provere, neuspehi i ponavljanje merenja](</Users/krcha/.codex/worktrees/e061/eventzeka-seo/.seo-cache/performance/public-release/browser/README.md>)
- [Zavrsna provera objave i zasticenog runtime-a](</Users/krcha/.codex/worktrees/e061/eventzeka-seo/.seo-cache/performance/public-release/web/deployment-guard-check-20261020T225543Z.json>)
