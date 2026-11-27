import type { Locale } from "@/i18n/config";
import type { CompassRecommendationReason } from "./compass";
import type { CompassVenueType } from "./venue-profile";

const messages = {
  durationShortMinute: ["min", "min", "мин"],
  durationAnd: ["i", "and", "и"],
  durationHourOne: ["sat", "hour", "час"],
  durationHourFew: ["sata", "hours", "часа"],
  durationHourMany: ["sati", "hours", "часов"],
  durationMinuteOne: ["minut", "minute", "минута"],
  durationMinuteFew: ["minuta", "minutes", "минуты"],
  durationMinuteMany: ["minuta", "minutes", "минут"],
  next: ["Gde dalje?", "Where next?", "Куда дальше?"],
  locate: ["Koristi moju lokaciju", "Use my location", "Моё местоположение"],
  locating: ["Tražimo tvoju lokaciju…", "Finding your location…", "Определяем местоположение…"],
  locationIntro: ["Potvrdi gde si, pa izaberi šta ti se radi dalje.", "Confirm where you are, then choose what you feel like doing next.", "Подтверди, где ты, и выбери, чем заняться дальше."],
  denied: ["Lokacija je blokirana. Dozvoli je u podešavanjima pregledača pa pokušaj ponovo.", "Location is blocked. Allow it in your browser settings and try again.", "Доступ к геолокации закрыт. Разреши его в настройках браузера и повтори."],
  unavailable: ["Lokacija nije dostupna. Proveri GPS pa pokušaj ponovo.", "Location is unavailable. Check GPS and try again.", "Местоположение недоступно. Проверь GPS и повтори."],
  timeout: ["GPS se nije javio na vreme. Pokušaj ponovo.", "GPS took too long. Try again.", "GPS не ответил вовремя. Повтори попытку."],
  here: ["Da li si ovde?", "Are you here?", "Ты здесь?"],
  no: ["Ne, sledeće mesto", "No, next place", "Нет, следующее место"],
  yes: ["Da, ovde sam", "Yes, I'm here", "Да, я здесь"],
  chooseAnotherVenue: ["Izaberi drugi lokal", "Choose a different venue", "Выбрать другое место"],
  venueName: ["Naziv lokala", "Venue name", "Название места"],
  nearestVenue: ["Najbliži lokal", "Nearest venue", "Ближайшее место"],
  vibe: ["Šta bi dalje?", "What next?", "Что дальше?"],
  same: ["Nešto isto", "Something similar", "Что-то похожее"],
  different: ["Nešto sasvim drugačije", "Something completely different", "Что-то совсем другое"],
  sameHint: ["Slična muzika, program ili vrsta lokala.", "Similar music, programme or venue type.", "Похожая музыка, программа или тип места."],
  differentHint: ["Promeni muziku ili vrstu izlaska.", "Change the music or type of outing.", "Другая музыка или формат вечера."],
  nearby: ["Otvorena mesta u blizini", "Open places nearby", "Открытые места рядом"],
  unknownVibe: ["Za ovaj lokal još nema podataka o večerašnjem fazonu. Možeš da pogledaš otvorena mesta u blizini.", "Tonight's vibe is not known here yet. You can explore open places nearby.", "Атмосфера сегодняшнего вечера пока неизвестна. Посмотри открытые места рядом."],
  walk: ["pešaka", "on foot", "пешком"],
  drive: ["kolima", "by car", "на машине"],
  estimate: ["Okvirno od tvoje lokacije", "Estimated from your location", "Примерно от тебя"],
  fromYou: ["Od tvoje lokacije", "From your location", "От тебя"],
  open: ["Lokal radi sada", "Venue open now", "Место сейчас открыто"],
  openAtArrival: ["Otvoreno po dolasku", "Open when you arrive", "Открыто к твоему приходу"],
  until: ["do", "until", "до"],
  loadingProgrammes: ["Učitavamo program…", "Loading programmes…", "Загружаем программу…"],
  loadingPlaces: ["Učitavamo lokale…", "Loading venues…", "Загружаем места…"],
  placesLoadError: ["Imenik lokala trenutno nije dostupan. Pokušaj ponovo.", "The venue directory is unavailable. Please try again.", "Список мест недоступен. Повтори попытку."],
  programmeLoadError: ["Program trenutno nije dostupan. Pokušaj ponovo.", "The programme is unavailable. Please try again.", "Программа недоступна. Повтори попытку."],
  loadError: ["Ponuda trenutno nije dostupna. Pokušaj ponovo.", "Listings are unavailable. Please try again.", "Подборка недоступна. Повтори попытку."],
  nearest: ["Od najbližeg ka daljim", "Nearest first", "Сначала ближайшие"],
  route: ["Prikaži rutu", "Show route", "Показать маршрут"],
  backToCompass: ["Vrati kompas", "Back to compass", "Вернуть компас"],
  musicProgramme: ["Prema najavljenom programu", "Based on the announced programme", "По объявленной программе"],
  musicRecent: ["Uobičajeni program · prethodni događaji", "Typical programme · recent events", "Обычная программа · прошлые события"],
  musicEstimated: ["AI procena žanra", "AI genre estimate", "Оценка жанра ИИ"],
  musicResearch: ["Istraženi stil izvođača", "Researched performer style", "Исследованный стиль исполнителя"],
  genreMissing: ["Žanrovi još nisu istraženi", "Genres have not been researched yet", "Жанры ещё не исследованы"],
  musicLookup: ["Proveravamo istražene žanrove…", "Checking researched genres…", "Проверяем исследованные жанры…"],
  musicLookupFailed: ["Žanrovi trenutno nisu dostupni. Pokušaj ponovo.", "Genre data is unavailable. Please retry.", "Данные о жанрах недоступны. Повтори попытку."],
  sourceReference: ["Poredi sa", "Compare with", "Сравнить с"],
  sourceAutomatic: ["Automatski izbor", "Automatic selection", "Автоматический выбор"],
  sourceVenue: ["Tip lokala", "Venue type", "Тип места"],
  unknownStart: ["Početak nije potvrđen", "Start time unconfirmed", "Время начала не подтверждено"],
  similarityScore: ["Procena sličnosti", "Estimated similarity", "Оценка сходства"],
  spectrumDifferent: ["Različito", "Different", "Другое"],
  spectrumSimilar: ["Slično", "Similar", "Похожее"],
  compareEvents: ["Uporedi događaje", "Compare events", "Сравнить события"],
  compareReference: ["Porediš sa", "Comparing with", "Сравнение с"],
  noEventMatches: ["Nema potvrđenih predloga u ovom periodu", "No verified matches in this period", "На этот период нет подтверждённых вариантов"],
  comparePeriod: ["Period preporuka", "Recommendation dates", "Период рекомендаций"],
  useLocationInstead: ["Izaberi lokal", "Choose a venue", "Выбрать место"],
  routeLoading: ["Učitavamo rutu…", "Loading route…", "Загружаем маршрут…"],
  mapLoading: ["Učitavamo mapu…", "Loading map…", "Загружаем карту…"],
  mapTilesError: ["Mapa nije učitana. Možeš da otvoriš navigaciju.", "Map tiles unavailable. You can open navigation.", "Карта недоступна. Можно открыть навигацию."],
  routeError: ["Ruta trenutno nije dostupna. Pokušaj ponovo ili otvori navigaciju.", "Route unavailable. Retry or open navigation.", "Маршрут недоступен. Повтори или открой навигацию."],
  navigation: ["Otvori navigaciju", "Open navigation", "Открыть навигацию"],
  nextPlace: ["Sledeće mesto", "Next place", "Следующее место"],
  previous: ["Prethodno", "Previous", "Назад"],
  change: ["Promeni fazon", "Change vibe", "Другая атмосфера"],
  reset: ["Promeni gde si", "Change your place", "Выбрать место заново"],
  empty: ["Nema potvrđeno otvorenih mesta u ovom fazonu.", "No confirmed open places with this vibe.", "Нет подтверждённых открытых мест с такой атмосферой."],
  emptyHint: ["Probaj drugi fazon ili pogledaj šta radi u blizini.", "Try another vibe or see what’s open nearby.", "Выбери другой вариант или посмотри, что открыто рядом."],
  noPlaces: ["Nema lokala sa potvrđenom lokacijom u aktuelnoj ponudi.", "No places with verified coordinates in the current listings.", "В текущей подборке нет мест с подтверждёнными координатами."],
  refresh: ["Proveri ponovo", "Check again", "Проверить снова"],
  end: ["To su svi predlozi za sada.", "That's all for now.", "Пока это все варианты."],
  north: ["Smer prema severu", "Bearing from north", "Направление от севера"],
  compass: ["Uključi kompas", "Enable compass", "Включить компас"],
  compassOn: ["Kompas je uključen", "Compass enabled", "Компас включён"],
  compassUnavailable: ["Kompas nije dostupan. Strelica pokazuje smer od severa.", "Compass unavailable. The arrow shows the bearing from north.", "Компас недоступен. Стрелка показывает направление от севера."],
  details: ["Detalji događaja", "Event details", "О событии"],
  venueDetails: ["Detalji lokala", "Venue details", "О месте"],
  musicUnknown: ["Za ovaj program još nemamo potvrđene žanrove.", "The genres for this programme are still unconfirmed.", "Жанры этой программы пока не подтверждены."],
} as const;

export type TravelCopyKey = keyof typeof messages;
type LocalizedCopy = readonly [string, string, string];

const recommendationReasons = {
  "same-genre": ["Isti žanr", "Same genre", "Тот же жанр"],
  "related-genre": ["Srodna muzika", "Related music", "Близкая музыка"],
  "same-venue-type": ["Isti tip lokala", "Same venue type", "Тот же тип места"],
  "contrast-genre-and-venue": ["Druga muzika i tip lokala", "Different music and venue type", "Другая музыка и тип места"],
  "contrast-genre": ["Drugačiji žanr", "Different genre", "Другой жанр"],
  "contrast-venue-type": ["Drugačiji tip lokala", "Different venue type", "Другой тип места"],
  "same-activity": ["Sličan program", "Similar programme", "Похожая программа"],
  "contrast-activity": ["Drugačiji program", "Different programme", "Другая программа"],
  nearby: ["U blizini", "Nearby", "Рядом"],
} as const satisfies Record<CompassRecommendationReason, LocalizedCopy>;

const venueTypes: Partial<Record<CompassVenueType, LocalizedCopy>> = {
  "cocktail-bar": ["Koktel bar", "Cocktail bar", "Коктейльный бар"],
  "wine-bar": ["Vinski bar", "Wine bar", "Винный бар"],
  kafana: ["Kafana", "Kafana", "Кафана"],
  pub: ["Pab", "Pub", "Паб"],
  bar: ["Bar", "Bar", "Бар"],
  club: ["Klub", "Nightclub", "Ночной клуб"],
  "live-music-venue": ["Lokal sa živom muzikom", "Live music venue", "Площадка с живой музыкой"],
  "restaurant/cafe": ["Restoran ili kafić", "Restaurant or café", "Ресторан или кафе"],
};

function localize(locale: Locale, copy: LocalizedCopy): string {
  return copy[locale === "sr" ? 0 : locale === "ru" ? 2 : 1];
}

export function travelText(locale: Locale, key: TravelCopyKey): string {
  return localize(locale, messages[key]);
}

export function compassRecommendationReasonText(locale: Locale, reason: CompassRecommendationReason): string {
  return localize(locale, recommendationReasons[reason]);
}

export function compassVenueTypeText(locale: Locale, type: CompassVenueType): string | undefined {
  const copy = venueTypes[type];
  return copy && localize(locale, copy);
}
