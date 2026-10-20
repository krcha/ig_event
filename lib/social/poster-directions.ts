import { AgendaRenderError } from "./agenda-layout.ts";

export const SOCIAL_DESIGN_VERSION = "27-material-motion-20261020-v4";
export type PosterFormat = "feed" | "story" | "reel";
export type PosterFontKey = "archivo" | "barlow" | "fraunces" | "syne" | "rubik" | "bodoni";
export type PosterFamily = {
  id: string; key: string; name: string; short: string; bg: string; ink: string;
  accent: string; dark: string; paper: string; display: PosterFontKey; eventFont: PosterFontKey;
  panel: string; colors: readonly string[]; description: string;
  // Retained for isolated saved previews. Production posters do not render intro copy.
  feedLine: string; reelLine: string; storyLine: string;
  compositionStyle?: "material"; rowFills?: readonly string[]; quietClosingLabels?: boolean;
};
export const POSTER_FAMILIES: readonly PosterFamily[] = [
  {
    "id": "01",
    "key": "riso",
    "name": "Riso / plavi otisak",
    "short": "Plavi otisak",
    "bg": "#537aca",
    "ink": "#dcffdc",
    "accent": "#ff735d",
    "dark": "#252043",
    "paper": "#dcffdc",
    "display": "archivo",
    "eventFont": "archivo",
    "panel": "riso",
    "colors": [
      "#d8f0b5",
      "#ffb5a3",
      "#b9d9f4",
      "#f6dc84"
    ],
    "description": "Grubi otisak, koralni potezi i mint papir. Krupna slova i malo pomereni slojevi boje.",
    "feedLine": "Plan za naredna tri dana.",
    "reelLine": "Četiri adrese za sutra.",
    "storyLine": "Četiri predloga za danas."
  },
  {
    "id": "02",
    "key": "afterhours",
    "name": "Afterhours / noćni kadar",
    "short": "Noćni kadar",
    "bg": "#080e1b",
    "ink": "#e9f3dc",
    "accent": "#c9ff53",
    "dark": "#101720",
    "paper": "#ebeedc",
    "display": "barlow",
    "eventFont": "barlow",
    "panel": "night",
    "colors": [
      "#d9ff6a",
      "#b9c7ff",
      "#f3c5df",
      "#9de4d8"
    ],
    "description": "Analogna fotografija, srebrni kolaž i oštra limeta. Tamni mirni pojasevi čuvaju čitljivost.",
    "feedLine": "Sačuvaj ove tri večeri.",
    "reelLine": "Sutra, kad padne mrak.",
    "storyLine": "Danas. Vremena su ispod."
  },
  {
    "id": "03",
    "key": "botanical",
    "name": "Herbarijum / narandžasti papir",
    "short": "Narandžasti papir",
    "bg": "#da864c",
    "ink": "#2f3922",
    "accent": "#b92731",
    "dark": "#343c26",
    "paper": "#fff1cc",
    "display": "fraunces",
    "eventFont": "syne",
    "panel": "botanical",
    "colors": [
      "#f9edc6",
      "#dce7b5",
      "#f5bb9c",
      "#e8d4bd"
    ],
    "description": "Botaničke senke, boja terakote i mekani serif. Program na komadima papira, bez gužve.",
    "feedLine": "Gde ćemo ovih dana?",
    "reelLine": "Sutra ima gde da se ode.",
    "storyLine": "Danas, od ranije do kasnije."
  },
  {
    "id": "04",
    "key": "ticket",
    "name": "Bilet / mali gradski teatar",
    "short": "Mali gradski teatar",
    "bg": "#171716",
    "ink": "#fff1c6",
    "accent": "#f9cd32",
    "dark": "#171716",
    "paper": "#ffefb2",
    "display": "archivo",
    "eventFont": "archivo",
    "panel": "ticket",
    "colors": [
      "#ff826d",
      "#f7cd45",
      "#9ad9ce",
      "#e9afd2"
    ],
    "description": "Stare ulaznice, ram u dve boje i mali kolaži. Živo i pomalo kabaretski, uz urednu satnicu.",
    "feedLine": "Tri dana, nekoliko dobrih adresa.",
    "reelLine": "Sutra biraj svoju scenu.",
    "storyLine": "Danas na programu."
  },
  {
    "id": "05",
    "key": "sleeve",
    "name": "B strana / omot ploče",
    "short": "Omot ploče",
    "bg": "#c7b9e4",
    "ink": "#252154",
    "accent": "#fc652d",
    "dark": "#29204e",
    "paper": "#eee8ff",
    "display": "syne",
    "eventFont": "syne",
    "panel": "sleeve",
    "colors": [
      "#e9dfff",
      "#c4d9f8",
      "#f8c3bd",
      "#e0e9b8"
    ],
    "description": "Lavanda, kobalt i hladan metal. Asimetrija omota ploče, diskretni brojevi i isečeni detalji.",
    "feedLine": "Prosledi ekipi. Pa se dogovorite.",
    "reelLine": "Sutra. Sačuvaj pa biraj.",
    "storyLine": "Danas ima nekoliko opcija."
  },
  {
    "id": "06",
    "key": "picnic",
    "name": "Linorez / subota u boji",
    "short": "Subota u boji",
    "bg": "#f6df86",
    "ink": "#223b37",
    "accent": "#d9443b",
    "dark": "#233b35",
    "paper": "#fff4c2",
    "display": "rubik",
    "eventFont": "archivo",
    "panel": "picnic",
    "colors": [
      "#f8b7b1",
      "#bed5ab",
      "#9bc9dd",
      "#edc2dc"
    ],
    "description": "Ručni linorez, cvet, zeka i nepravilna šahovnica. Vedro, ali sa dovoljno praznog prostora.",
    "feedLine": "Otvori raspored, pa izađi.",
    "reelLine": "Četiri stvari za sutra.",
    "storyLine": "Danas. Imaš ceo dan."
  },
  {
    "id": "07",
    "key": "sunday",
    "name": "Nedelja / višnjev kolaž",
    "short": "Višnjev kolaž",
    "bg": "#652b3b",
    "ink": "#fff0d0",
    "accent": "#f4d363",
    "dark": "#4e2330",
    "paper": "#fff0d0",
    "display": "bodoni",
    "eventFont": "syne",
    "panel": "sunday",
    "colors": [
      "#f4daca",
      "#d5d6ed",
      "#e9d684",
      "#ebbcce"
    ],
    "description": "Višnja, puter žuta i isečci iz knjige. Mirniji ritam, veći razmaci i jasan red čitanja.",
    "feedLine": "Još nekoliko razloga da izađeš.",
    "reelLine": "Za sutra, bez žurbe.",
    "storyLine": "Danas može i polako."
  },
  {
    "id": "08",
    "key": "haze",
    "name": "Magla / ružičasti kadar",
    "short": "Magla",
    "bg": "#301323",
    "ink": "#fff2dd",
    "accent": "#fa8ddc",
    "dark": "#3b2030",
    "paper": "#f8e6e6",
    "display": "bodoni",
    "eventFont": "syne",
    "panel": "haze",
    "colors": [
      "#f1cade",
      "#d9c9f0",
      "#f6d09c",
      "#bdddd8"
    ],
    "description": "Analogna magla, svetlosni trag i serif. Mirni pojasevi čuvaju čitljivost programa.",
    "feedLine": "Prelistaj naredne dane.",
    "reelLine": "Predlozi za sutra.",
    "storyLine": "Danas na nekoliko adresa."
  },
  {
    "id": "09",
    "key": "tribal",
    "name": "Cyber tribal / hrom i trnje",
    "short": "Cyber tribal",
    "bg": "#101016",
    "ink": "#eef0f5",
    "accent": "#c9f181",
    "dark": "#12151d",
    "paper": "#ebe7ff",
    "display": "barlow",
    "eventFont": "syne",
    "panel": "tribal",
    "colors": [
      "#d2d4e3",
      "#d4bdf8",
      "#c9f181",
      "#8ed8e4"
    ],
    "description": "Hromirani organski okvir, grafit i hladni akcenti. Oštri detalji ostaju na rubovima.",
    "feedLine": "Izaberi dan, pa adresu.",
    "reelLine": "Četiri predloga za sutra.",
    "storyLine": "Današnji raspored je tu."
  },
  {
    "id": "10",
    "key": "redprint",
    "name": "Crveni raster / klupski otisak",
    "short": "Crveni raster",
    "bg": "#111111",
    "ink": "#fff0d8",
    "accent": "#fa493f",
    "dark": "#181113",
    "paper": "#fff0d8",
    "display": "barlow",
    "eventFont": "barlow",
    "panel": "redprint",
    "colors": [
      "#fa6358",
      "#f3c3b2",
      "#edc44a",
      "#c3d4d1"
    ],
    "description": "Crveno-crna štampa, iscepana traka i grubi raster. Nazivi ostaju čisti i krupni.",
    "feedLine": "Raspored za naredne dane.",
    "reelLine": "Sutra u Beogradu.",
    "storyLine": "Danas. Satnice su ispod."
  },
  {
    "id": "11",
    "key": "laser",
    "name": "Crveno staklo / noćna mreža",
    "short": "Crveno staklo",
    "bg": "#18070c",
    "ink": "#edfacd",
    "accent": "#ff453e",
    "dark": "#1b0c12",
    "paper": "#edfacd",
    "display": "archivo",
    "eventFont": "barlow",
    "panel": "laser",
    "colors": [
      "#dff3bb",
      "#edbfc0",
      "#cbd2f3",
      "#f5d397"
    ],
    "description": "Crveni odsjaji, slojevi tamnog stakla i precizne linije. Sveden raspored, jaka pozadina.",
    "feedLine": "Još nekoliko adresa za izlazak.",
    "reelLine": "Sačuvaj satnice za sutra.",
    "storyLine": "Danas na programu."
  },
  {
    "id": "12",
    "key": "bioblue",
    "name": "Plava membrana / organski signal",
    "short": "Plava membrana",
    "bg": "#0b1310",
    "ink": "#edf2d8",
    "accent": "#47baff",
    "dark": "#111b18",
    "paper": "#edf2d8",
    "display": "archivo",
    "eventFont": "barlow",
    "panel": "bio",
    "colors": [
      "#9fdcf2",
      "#e4df9b",
      "#b9d7ba",
      "#c4bde3"
    ],
    "description": "Plave organske membrane, maslinasti rubovi i tragovi solarizacije. Tekst ima mirnu tamnu podlogu.",
    "feedLine": "Za dane koji dolaze.",
    "reelLine": "Evo šta se sprema za sutra.",
    "storyLine": "Četiri predloga za danas."
  },
  {
    "id": "13",
    "key": "signal",
    "name": "Amber / analogni trag",
    "short": "Analogni trag",
    "bg": "#081a0d",
    "ink": "#fff0d0",
    "accent": "#f4b342",
    "dark": "#102017",
    "paper": "#fff0d0",
    "display": "rubik",
    "eventFont": "barlow",
    "panel": "signal",
    "colors": [
      "#f4c46f",
      "#bad8b1",
      "#d4bce9",
      "#a5cadf"
    ],
    "description": "Amber svetlo, zelena senka i tanka metalna linija. Kadar starog video snimka sa jasnim programom.",
    "feedLine": "Prosledi raspored ekipi.",
    "reelLine": "Četiri adrese za sutra.",
    "storyLine": "Danas ima gde da se ode."
  },
  {
    "id": "14",
    "key": "posle-ponoci",
    "name": "Posle ponoći",
    "description": "Hladan blic, ogledalske pločice i duboka senka. Noćna fotografija sa oštrim srebrnim rubovima.",
    "bg": "#101014",
    "ink": "#FFF4DE",
    "accent": "#9762D5",
    "dark": "#17192B",
    "paper": "#FFF4DE",
    "display": "bodoni",
    "eventFont": "syne",
    "panel": "night",
    "colors": [
      "#C2CDF9",
      "#D8B7EE",
      "#A8DCDA",
      "#F0D6AC"
    ],
    "rowFills": [
      "#17192B",
      "#241A36",
      "#0D2434",
      "#25243C"
    ],
    "short": "Posle ponoći",
    "compositionStyle": "material",
    "feedLine": "Plan za naredna tri dana.",
    "reelLine": "Sutra na ove četiri adrese.",
    "storyLine": "Danas u Beogradu."
  },
  {
    "id": "15",
    "key": "ruzicasta-temperatura",
    "name": "Ružičasta temperatura",
    "description": "Malina, krem plamen i grub fotografski raster. Vrela štampa i odsjaj umesto ravne ružičaste podloge.",
    "bg": "#AE164C",
    "ink": "#FFEBDC",
    "accent": "#FFD990",
    "dark": "#4B122E",
    "paper": "#FFEBDC",
    "display": "archivo",
    "eventFont": "archivo",
    "panel": "heat",
    "colors": [
      "#FFE1BA",
      "#FFC7E1",
      "#E9CFFF",
      "#FFD990"
    ],
    "rowFills": [
      "#5B173D",
      "#782344",
      "#4B1239",
      "#6B253D"
    ],
    "short": "Ružičasta temperatura",
    "compositionStyle": "material",
    "feedLine": "Prelistaj naredna tri dana.",
    "reelLine": "Četiri predloga za sutra.",
    "storyLine": "Danas ima gde da se ode."
  },
  {
    "id": "16",
    "key": "hrom-u-trnju",
    "name": "Hrom u trnju",
    "description": "Savijeni metal, tanki šiljci i svetli rezovi. Cyber tribal ornament ostaje na ivicama programa.",
    "bg": "#15191C",
    "ink": "#F4F0E6",
    "accent": "#E4FF73",
    "dark": "#1A2026",
    "paper": "#F4F0E6",
    "display": "barlow",
    "eventFont": "syne",
    "panel": "tribal",
    "colors": [
      "#E4FF73",
      "#B9C3CE",
      "#C9B9F2",
      "#B9DED5"
    ],
    "rowFills": [
      "#1A2026",
      "#212531",
      "#1B2A27",
      "#252137"
    ],
    "short": "Hrom u trnju",
    "compositionStyle": "material",
    "feedLine": "Tri dana, nekoliko dobrih adresa.",
    "reelLine": "Sutrašnji raspored je tu.",
    "storyLine": "Danas. Satnice su ispod."
  },
  {
    "id": "17",
    "key": "fluoro-kopija",
    "name": "Fluoro kopija",
    "description": "Fotokopija, pomereni fluoro otisak i tragovi lepka. Svaki događaj dobija drugu boju papira i drugi rez.",
    "bg": "#E7FF22",
    "ink": "#16201B",
    "accent": "#ED4BA6",
    "dark": "#16201B",
    "paper": "#F1EEDC",
    "display": "rubik",
    "eventFont": "archivo",
    "panel": "xerox",
    "colors": [
      "#E7FF5A",
      "#F4C9E3",
      "#D3E7DD",
      "#F1EEDC"
    ],
    "rowFills": [
      "#E7FF5A",
      "#F4C9E3",
      "#D3E7DD",
      "#F1EEDC"
    ],
    "short": "Fluoro kopija",
    "compositionStyle": "material",
    "feedLine": "Sačuvaj raspored za naredne dane.",
    "reelLine": "Sutra. Sačuvaj pa biraj.",
    "storyLine": "Četiri predloga za danas."
  },
  {
    "id": "18",
    "key": "plavi-negativ",
    "name": "Plavi negativ",
    "description": "Solarizovana folija i voda. Cijan svetli duž organskih ivica, a tamnoplavi program ostaje miran.",
    "bg": "#061E37",
    "ink": "#ECE5D4",
    "accent": "#08A8D1",
    "dark": "#06243F",
    "paper": "#ECE5D4",
    "display": "barlow",
    "eventFont": "barlow",
    "panel": "bio",
    "colors": [
      "#A9DEF0",
      "#D9CCAD",
      "#B4C7E5",
      "#B9DDD1"
    ],
    "rowFills": [
      "#06243F",
      "#09324B",
      "#10263F",
      "#173140"
    ],
    "short": "Plavi negativ",
    "compositionStyle": "material",
    "feedLine": "Za dane koji dolaze.",
    "reelLine": "Evo šta se sprema za sutra.",
    "storyLine": "Danas na nekoliko adresa."
  },
  {
    "id": "19",
    "key": "iseceni-ritam",
    "name": "Isečeni ritam",
    "description": "Karte, obojeni papir i providna traka. Kolaž menja izreze po događaju, dok tekst ostaje vodoravan.",
    "bg": "#F1E6CF",
    "ink": "#21201C",
    "accent": "#D93A31",
    "dark": "#21201C",
    "paper": "#F1E6CF",
    "display": "fraunces",
    "eventFont": "syne",
    "panel": "collage",
    "colors": [
      "#F4D2BB",
      "#C5D8EF",
      "#E9DBA8",
      "#D4E2CF"
    ],
    "rowFills": [
      "#F4D2BB",
      "#C5D8EF",
      "#E9DBA8",
      "#D4E2CF"
    ],
    "short": "Isečeni ritam",
    "compositionStyle": "material",
    "feedLine": "Prosledi ekipi. Pa se dogovorite.",
    "reelLine": "Za sutra smo izdvojili ove adrese.",
    "storyLine": "Danas na programu."
  },
  {
    "id": "20",
    "key": "opalni-signal",
    "name": "Opalni signal",
    "description": "Opalni listovi, satenski nabor i kajsija rez. Mirniji poster sa stvarnom dubinom materijala.",
    "bg": "#F7EEDF",
    "ink": "#402F59",
    "accent": "#E49D77",
    "dark": "#402F59",
    "paper": "#F7EEDF",
    "display": "bodoni",
    "eventFont": "syne",
    "panel": "opal",
    "colors": [
      "#E2D5EF",
      "#D2E2C6",
      "#F1D1BA",
      "#F4E9D9"
    ],
    "rowFills": [
      "#E2D5EF",
      "#D2E2C6",
      "#F1D1BA",
      "#F4E9D9"
    ],
    "short": "Opalni signal",
    "compositionStyle": "material",
    "feedLine": "Još nekoliko razloga da izađeš.",
    "reelLine": "Nekoliko predloga za sutra.",
    "storyLine": "Danas može i polako."
  },
  {
    "id": "21",
    "key": "crni-kadar",
    "name": "Crni kadar",
    "description": "Crno-bela analogna fotografija, grubo zrno i svetlost koja seče tamu. Veliki serif i tihi srebrni rubovi daju programu ritam filmskog kadra.",
    "bg": "#121210",
    "ink": "#F2ECDD",
    "accent": "#A7A39A",
    "dark": "#1C1B19",
    "paper": "#F2ECDD",
    "display": "bodoni",
    "eventFont": "syne",
    "panel": "night",
    "compositionStyle": "material",
    "colors": [
      "#E8E3D6",
      "#C4C4BD",
      "#D4C6B7",
      "#B9BCBA"
    ],
    "rowFills": [
      "#171715",
      "#22211E",
      "#121719",
      "#26231F"
    ],
    "feedLine": "",
    "reelLine": "",
    "storyLine": "",
    "short": "Crni kadar",
    "quietClosingLabels": true
  },
  {
    "id": "22",
    "key": "crvena-margina",
    "name": "Crvena margina",
    "description": "Crn tuš, belina papira i oštar crveni rez. Mračni grafički poster sa energijom ručno štampanog filmskog plakata.",
    "bg": "#110A0B",
    "ink": "#FFF3DF",
    "accent": "#E23A32",
    "dark": "#210E12",
    "paper": "#FFF3DF",
    "display": "archivo",
    "eventFont": "barlow",
    "panel": "redprint",
    "compositionStyle": "material",
    "colors": [
      "#F4DCC4",
      "#F19C91",
      "#DED9CE",
      "#E9B7B0"
    ],
    "rowFills": [
      "#230F14",
      "#311116",
      "#1C1718",
      "#35171A"
    ],
    "feedLine": "",
    "reelLine": "",
    "storyLine": "",
    "short": "Crvena margina",
    "quietClosingLabels": true
  },
  {
    "id": "23",
    "key": "kabinet-tusa",
    "name": "Kabinet tuša",
    "description": "Bakropis, topla slonovača i trag crvenog pečata. Ilustracija se ponaša kao stranica stare knjige, sa jasnim prostorom za savremeni gradski program.",
    "bg": "#E5DAC5",
    "ink": "#201D18",
    "accent": "#A72F2B",
    "dark": "#201D18",
    "paper": "#F3EADB",
    "display": "fraunces",
    "eventFont": "syne",
    "panel": "collage",
    "compositionStyle": "material",
    "colors": [
      "#E7D8BB",
      "#D9D9C6",
      "#EDC8B4",
      "#D8D0C4"
    ],
    "rowFills": [
      "#E7D8BB",
      "#D9D9C6",
      "#EDC8B4",
      "#D8D0C4"
    ],
    "feedLine": "",
    "reelLine": "",
    "storyLine": "",
    "short": "Kabinet tuša",
    "quietClosingLabels": true
  },
  {
    "id": "24",
    "key": "plavi-bakrorez",
    "name": "Plavi bakrorez",
    "description": "Prusko plava, svetla gravirana linija i trag prašnjavog otiska. Hladna dubina i precizni rezovi čine program preglednim i bez ravne digitalne podloge.",
    "bg": "#071E30",
    "ink": "#F1E7D0",
    "accent": "#76A3B9",
    "dark": "#102C3C",
    "paper": "#F1E7D0",
    "display": "barlow",
    "eventFont": "barlow",
    "panel": "bio",
    "compositionStyle": "material",
    "colors": [
      "#C8DCE0",
      "#B6CAD8",
      "#E1D6BF",
      "#A7C6C7"
    ],
    "rowFills": [
      "#0C2434",
      "#173447",
      "#102A38",
      "#1B3542"
    ],
    "feedLine": "",
    "reelLine": "",
    "storyLine": "",
    "short": "Plavi bakrorez",
    "quietClosingLabels": true
  },
  {
    "id": "25",
    "key": "ljubicasti-kontakt",
    "name": "Ljubičasti kontakt",
    "description": "Šljiva, lavanda i krem odsjaj na zrnastoj fotografiji. Krupni serif, čipka i meke senke podsećaju na kontakt kopiju iz tamne komore.",
    "bg": "#271A2B",
    "ink": "#F2E7D7",
    "accent": "#BA9DBB",
    "dark": "#322236",
    "paper": "#F2E7D7",
    "display": "bodoni",
    "eventFont": "syne",
    "panel": "night",
    "compositionStyle": "material",
    "colors": [
      "#E4CAD9",
      "#CBBEDB",
      "#E8D8BB",
      "#B8CDCB"
    ],
    "rowFills": [
      "#2D1D32",
      "#3C2941",
      "#292534",
      "#3B2835"
    ],
    "feedLine": "",
    "reelLine": "",
    "storyLine": "",
    "short": "Ljubičasti kontakt",
    "quietClosingLabels": true
  },
  {
    "id": "26",
    "key": "zeleni-fanzin",
    "name": "Zeleni fanzin",
    "description": "Kisela zelena, crni xerox i oksidno narandžast potez. Pocepani papir i pomereni otisak daju svakom događaju sopstveni mali plakat.",
    "bg": "#D5E642",
    "ink": "#192016",
    "accent": "#B94D2A",
    "dark": "#192016",
    "paper": "#F0E9D6",
    "display": "rubik",
    "eventFont": "barlow",
    "panel": "xerox",
    "compositionStyle": "material",
    "colors": [
      "#DDEB72",
      "#E8D8BD",
      "#CCD6A9",
      "#F0E9D6"
    ],
    "rowFills": [
      "#DDEB72",
      "#E8D8BD",
      "#CCD6A9",
      "#F0E9D6"
    ],
    "feedLine": "",
    "reelLine": "",
    "storyLine": "",
    "short": "Zeleni fanzin",
    "quietClosingLabels": true
  },
  {
    "id": "27",
    "key": "karminski-odjek",
    "name": "Karminski odjek",
    "description": "Vinska tamna podloga, bakarno ružičasta i izgreban tuš. Fragmenti pozorišne maske i nervozni crteži lica ostaju uz rub, dok program dobija mirnu površinu za čitanje.",
    "bg": "#35131F",
    "ink": "#F8E7D3",
    "accent": "#C68177",
    "dark": "#401E28",
    "paper": "#F8E7D3",
    "display": "bodoni",
    "eventFont": "syne",
    "panel": "heat",
    "compositionStyle": "material",
    "colors": [
      "#E6B8A9",
      "#D6B8C7",
      "#F0D7B5",
      "#C7C1BC"
    ],
    "rowFills": [
      "#401B28",
      "#51232F",
      "#371C29",
      "#4C2930"
    ],
    "feedLine": "",
    "reelLine": "",
    "storyLine": "",
    "short": "Karminski odjek",
    "quietClosingLabels": true
  }
];
export const POSTER_CYCLE_LENGTH = POSTER_FAMILIES.length * 3;
export type PosterDesignReceipt = { id: string; name: string; composition: number; cyclePosition: number; cycleLength: number; publishDate: string; key: string; motionVariant: number };
const ANCHOR = Date.UTC(2026, 9, 19);
const modulo = (n: number, d: number) => ((n % d) + d) % d;

export function resolvePosterPublicationDate(date: string, position = 0, format: PosterFormat = "feed", publishDate?: string): string {
  const millis = Date.parse(date + "T12:00:00Z");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !Number.isFinite(millis) || new Date(millis).toISOString().slice(0,10) !== date ||
    !Number.isInteger(position) || position < 0 || position > 2) throw new AgendaRenderError("Invalid artwork date or position.");
  const inferred = new Date(millis - (format === "feed" ? position + 1 : format === "reel" ? 1 : 0) * 86400000).toISOString().slice(0,10);
  const resolved = publishDate ?? inferred;
  const publicationMillis = Date.parse(resolved + "T12:00:00Z");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(resolved) || !Number.isFinite(publicationMillis) || new Date(publicationMillis).toISOString().slice(0,10) !== resolved) {
    throw new AgendaRenderError("Invalid artwork publication date.");
  }
  return resolved;
}

export function getPosterDirection(date: string, position = 0, format: PosterFormat = "feed", publicationDate?: string) {
  // Explicit publication identity also supports sparse/custom event windows.
  // Legacy public URLs infer their day; no format-specific phase is applied.
  const publishDate = resolvePosterPublicationDate(date, position, format, publicationDate);
  const publishOrdinal = Math.floor((Date.parse(publishDate + "T12:00:00Z") - ANCHOR) / 86400000);
  const families = publishOrdinal < 0 ? POSTER_FAMILIES.slice(0, 13) : POSTER_FAMILIES;
  const cycleLength = families.length * 3;
  const sequence = modulo(publishOrdinal, cycleLength);
  const family = families[sequence % families.length];
  const composition = Math.floor(sequence / families.length);
  const colorOffset = modulo(composition + position, 4);
  const dailyDesignKey = `eventzeka:${publishDate}:${family.id}:${composition}`;
  let hash = 2166136261;
  for (const char of dailyDesignKey) { hash ^= char.charCodeAt(0); hash = Math.imul(hash, 16777619); }
  const motionVariant = (hash >>> 0) % 3;
  return { ...family, sequence, composition, colorOffset, cycleLength, publishDate, dailyDesignKey, motionVariant,
    colors: family.colors.map((_,i) => family.colors[modulo(i + colorOffset, 4)]),
    rowFills: family.rowFills?.map((_,i) => family.rowFills![modulo(i + colorOffset, 4)]) };
}

export function getPosterDesignReceipt(date: string, position = 0, format: PosterFormat = "feed", publishDate?: string): PosterDesignReceipt {
  const theme = getPosterDirection(date, position, format, publishDate);
  return { id: theme.id, name: theme.name, composition: theme.composition + 1, cyclePosition: theme.sequence + 1, cycleLength: theme.cycleLength, publishDate: theme.publishDate, key: theme.dailyDesignKey, motionVariant: theme.motionVariant };
}

