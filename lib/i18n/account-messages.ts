import type { Locale } from "@/i18n/config";

/** Public account, navigation and installation copy. Machine IDs stay unchanged. */
export const accountMessages = {
  "nav.events": {
    "en": "Events",
    "sr": "Događaji",
    "ru": "События"
  },
  "nav.discover": {
    "en": "Discover",
    "sr": "Otkrij",
    "ru": "Подборка"
  },
  "nav.map": {
    "en": "Map",
    "sr": "Mapa",
    "ru": "Карта"
  },
  "nav.saved": {
    "en": "Saved",
    "sr": "Sačuvano",
    "ru": "Избранное"
  },
  "nav.followInstagram": {
    "en": "Follow @eventzeka on Instagram",
    "sr": "Prati @eventzeka na Instagramu",
    "ru": "Подписаться на @eventzeka в Instagram"
  },
  "nav.instagramA11y": {
    "en": "Follow @eventzeka on Instagram (opens in a new tab)",
    "sr": "Prati @eventzeka na Instagramu (otvara se u novoj kartici)",
    "ru": "Подписаться на @eventzeka в Instagram (откроется в новой вкладке)"
  },
  "nav.follow": {
    "en": "Follow",
    "sr": "Prati",
    "ru": "Подписаться"
  },
  "nav.homeA11y": {
    "en": "Event Zeka home",
    "sr": "Event Zeka početna stranica",
    "ru": "Главная страница Event Zeka"
  },
  "nav.profile": {
    "en": "Your profile",
    "sr": "Tvoj profil",
    "ru": "Ваш профиль"
  },
  "profile.accountTitle": {
    "en": "Your Event Zeka account",
    "sr": "Tvoj Event Zeka nalog",
    "ru": "Ваш аккаунт Event Zeka"
  },
  "profile.noEmail": {
    "en": "No email on file",
    "sr": "Email nije dodat",
    "ru": "Адрес электронной почты не указан"
  },
  "profile.savedEvents": {
    "en": "Saved events",
    "sr": "Sačuvani događaji",
    "ru": "Сохранённые события"
  },
  "profile.favouritePlaces": {
    "en": "Favourite places",
    "sr": "Omiljena mesta",
    "ru": "Избранные места"
  },
  "profile.scenes": {
    "en": "Your scenes",
    "sr": "Tvoja interesovanja",
    "ru": "Ваши интересы"
  },
  "profile.addScene": {
    "en": "Add a scene",
    "sr": "Dodaj interesovanje",
    "ru": "Добавить интерес"
  },
  "profile.signingOut": {
    "en": "Signing out...",
    "sr": "Odjavljivanje…",
    "ru": "Выход…"
  },
  "profile.signOut": {
    "en": "Sign out",
    "sr": "Odjavi se",
    "ru": "Выйти"
  },
  "auth.signIn": {
    "en": "Sign in",
    "sr": "Prijavi se",
    "ru": "Войти"
  },
  "auth.signUp": {
    "en": "Create an account",
    "sr": "Napravi nalog",
    "ru": "Создать аккаунт"
  },
  "auth.signInDescription": {
    "en": "Sync saved events and favourite places across your devices.",
    "sr": "Sinhronizuj sačuvane događaje i omiljena mesta na svojim uređajima.",
    "ru": "Синхронизируйте сохранённые события и избранные места на своих устройствах."
  },
  "auth.noAccount": {
    "en": "Don't have an account?",
    "sr": "Nemaš nalog?",
    "ru": "Нет аккаунта?"
  },
  "auth.existingAccount": {
    "en": "Already have an account?",
    "sr": "Već imaš nalog?",
    "ru": "Уже есть аккаунт?"
  },
  "auth.verifyEmail": {
    "en": "Verify email",
    "sr": "Potvrdi email",
    "ru": "Подтвердить электронную почту"
  },
  "auth.verifySignIn": {
    "en": "Verify sign-in",
    "sr": "Potvrdi prijavu",
    "ru": "Подтвердить вход"
  },
  "auth.extraVerification": {
    "en": "One more step to verify it's you.",
    "sr": "Još jedan korak da potvrdimo da si to ti.",
    "ru": "Ещё один шаг, чтобы подтвердить, что это вы."
  },
  "auth.forgotPassword": {
    "en": "Forgot password?",
    "sr": "Zaboravljena lozinka?",
    "ru": "Забыли пароль?"
  },
  "auth.enterCode": {
    "en": "Enter the code",
    "sr": "Unesi kod",
    "ru": "Введите код"
  },
  "auth.emailCode": {
    "en": "Email code",
    "sr": "Kod iz emaila",
    "ru": "Код из письма"
  },
  "auth.newPassword": {
    "en": "New password",
    "sr": "Nova lozinka",
    "ru": "Новый пароль"
  },
  "auth.passwordMismatch": {
    "en": "The new passwords do not match. Enter the same password in both fields.",
    "sr": "Nove lozinke se ne podudaraju. Unesi istu lozinku u oba polja.",
    "ru": "Новые пароли не совпадают. Введите одинаковый пароль в обоих полях."
  },
  "auth.signingIn": {
    "en": "Signing in…",
    "sr": "Prijavljivanje…",
    "ru": "Вход…"
  },
  "auth.verifying": {
    "en": "Verifying…",
    "sr": "Proveravanje…",
    "ru": "Проверка…"
  },
  "auth.confirmSignIn": {
    "en": "Verify and sign in",
    "sr": "Potvrdi i prijavi se",
    "ru": "Подтвердить и войти"
  },
  "auth.confirmCode": {
    "en": "Verify code",
    "sr": "Potvrdi kod",
    "ru": "Подтвердить код"
  },
  "auth.creatingAccount": {
    "en": "Creating account…",
    "sr": "Pravljenje naloga…",
    "ru": "Создание аккаунта…"
  },
  "auth.backToSignIn": {
    "en": "Back to sign-in",
    "sr": "Nazad na prijavu",
    "ru": "Вернуться ко входу"
  },
  "auth.sending": {
    "en": "Sending…",
    "sr": "Slanje…",
    "ru": "Отправка…"
  },
  "auth.sendCode": {
    "en": "Send code",
    "sr": "Pošalji kod",
    "ru": "Отправить код"
  },
  "install.promptA11y": {
    "en": "Close installation suggestion",
    "sr": "Zatvori predlog za instalaciju",
    "ru": "Закрыть предложение об установке"
  },
  "install.description": {
    "en": "Your app for Belgrade events",
    "sr": "Aplikacija za događaje u Beogradu",
    "ru": "Приложение для событий в Белграде"
  },
  "install.notNow": {
    "en": "Not now",
    "sr": "Ne sada",
    "ru": "Не сейчас"
  },
  "install.backEvents": {
    "en": "Back to events",
    "sr": "Nazad na događaje",
    "ru": "Назад к событиям"
  },
  "install.chooseDevice": {
    "en": "Choose your device",
    "sr": "Izaberi uređaj",
    "ru": "Выберите устройство"
  },
  "install.instructions": {
    "en": "Installation guide",
    "sr": "Uputstvo za instalaciju",
    "ru": "Инструкция по установке"
  },
  "install.confirmInBrowser": {
    "en": "Confirm installation in your browser.",
    "sr": "Instalaciju potvrđuješ u pregledaču.",
    "ru": "Подтвердите установку в браузере."
  },
  "common.loading": {
    "sr": "Učitavanje",
    "en": "Loading",
    "ru": "Загрузка"
  },
  "nav.global": {
    "sr": "Glavna navigacija",
    "en": "Main navigation",
    "ru": "Главная навигация"
  },
  "nav.mobile": {
    "sr": "Mobilna navigacija",
    "en": "Mobile navigation",
    "ru": "Мобильная навигация"
  },
  "nav.loading": {
    "sr": "Učitavanje: {page}",
    "en": "Loading {page}",
    "ru": "Загрузка: {page}"
  },
  "nav.chooseLanguage": {
    "sr": "Izaberi jezik",
    "en": "Choose language",
    "ru": "Выберите язык"
  },
  "nav.language": {
    "sr": "Jezik",
    "en": "Language",
    "ru": "Язык"
  },
  "auth.signUpDescription": {
    "sr": "Čuvaj događaje i omiljena mesta i pristupaj im sa drugih uređaja.",
    "en": "Save events and favourite places and access them on your other devices.",
    "ru": "Сохраняйте события и любимые места и открывайте их на других устройствах."
  },
  "auth.codeSent": {
    "sr": "Unesi kod koji smo poslali na {email}.",
    "en": "Enter the code we sent to {email}.",
    "ru": "Введите код, отправленный на {email}."
  },
  "auth.resetDescription": {
    "sr": "Unesi email svog naloga. Poslaćemo ti jednokratni kod za promenu lozinke.",
    "en": "Enter your account email. We will send a one-time code to reset your password.",
    "ru": "Введите почту вашего аккаунта. Мы отправим одноразовый код для смены пароля."
  },
  "auth.enterCodeDescription": {
    "sr": "Unesi kod koji smo poslali na email tvog naloga.",
    "en": "Enter the code we sent to your account email.",
    "ru": "Введите код, отправленный на почту вашего аккаунта."
  },
  "auth.newPasswordDescription": {
    "sr": "Izaberi novu lozinku. Nakon promene bićeš odjavljen sa ostalih uređaja.",
    "en": "Choose a new password. You will be signed out on your other devices.",
    "ru": "Выберите новый пароль. Сеансы на других устройствах будут завершены."
  },
  "auth.loading": {
    "sr": "Prijava se još učitava. Pokušaj ponovo.",
    "en": "Sign in is still loading. Please try again.",
    "ru": "Вход ещё загружается. Попробуйте ещё раз."
  },
  "auth.errorSignIn": {
    "sr": "Prijava nije uspela. Proveri email i lozinku i pokušaj ponovo.",
    "en": "Sign in failed. Check your email and password and try again.",
    "ru": "Не удалось войти. Проверьте почту и пароль и попробуйте ещё раз."
  },
  "auth.errorVerify": {
    "sr": "Kod nije potvrđen. Proveri kod i pokušaj ponovo.",
    "en": "The code could not be verified. Check it and try again.",
    "ru": "Не удалось подтвердить код. Проверьте его и попробуйте ещё раз."
  },
  "auth.errorNewCode": {
    "sr": "Novi kod nije poslat. Pokušaj ponovo.",
    "en": "A new code could not be sent. Please try again.",
    "ru": "Не удалось отправить новый код. Попробуйте ещё раз."
  },
  "auth.errorReset": {
    "sr": "Promena lozinke nije pokrenuta. Pokušaj ponovo.",
    "en": "Password reset could not start. Please try again.",
    "ru": "Не удалось начать смену пароля. Попробуйте ещё раз."
  },
  "auth.errorResetCode": {
    "sr": "Kod za promenu lozinke nije poslat. Pokušaj ponovo.",
    "en": "The password reset code could not be sent. Please try again.",
    "ru": "Не удалось отправить код для смены пароля. Попробуйте ещё раз."
  },
  "auth.errorPasswordChange": {
    "sr": "Lozinka nije promenjena. Pokušaj ponovo.",
    "en": "Your password was not changed. Please try again.",
    "ru": "Не удалось изменить пароль. Попробуйте ещё раз."
  },
  "auth.errorSignUp": {
    "sr": "Nalog nije napravljen. Proveri podatke i pokušaj ponovo.",
    "en": "Your account could not be created. Check your details and try again.",
    "ru": "Не удалось создать аккаунт. Проверьте данные и попробуйте ещё раз."
  },
  "auth.email": {
    "sr": "Email",
    "en": "Email",
    "ru": "Электронная почта"
  },
  "auth.password": {
    "sr": "Lozinka",
    "en": "Password",
    "ru": "Пароль"
  },
  "auth.username": {
    "sr": "Korisničko ime",
    "en": "Username",
    "ru": "Имя пользователя"
  },
  "auth.verificationCode": {
    "sr": "Kod za potvrdu",
    "en": "Verification code",
    "ru": "Код подтверждения"
  },
  "auth.resendIn": {
    "sr": "Novi kod za {seconds} s",
    "en": "New code in {seconds}s",
    "ru": "Новый код через {seconds} с"
  },
  "auth.resendCode": {
    "sr": "Pošalji novi kod",
    "en": "Send a new code",
    "ru": "Отправить новый код"
  },
  "auth.sendVerificationCode": {
    "sr": "Pošalji kod za potvrdu",
    "en": "Send verification code",
    "ru": "Отправить код подтверждения"
  },
  "auth.accountEmail": {
    "sr": "email tvog naloga",
    "en": "your account email",
    "ru": "почту вашего аккаунта"
  },
  "auth.codeRequired": {
    "sr": "Za završetak prijave potreban je kod iz emaila. Ako nije stigao, zatraži ga ispod.",
    "en": "An email code is needed to finish signing in. If it has not arrived, request it below.",
    "ru": "Для завершения входа нужен код из письма. Если письмо не пришло, запросите его ниже."
  },
  "auth.confirmPassword": {
    "sr": "Potvrdi novu lozinku",
    "en": "Confirm new password",
    "ru": "Повторите новый пароль"
  },
  "auth.saving": {
    "sr": "Čuvanje…",
    "en": "Saving…",
    "ru": "Сохранение…"
  },
  "auth.savePassword": {
    "sr": "Sačuvaj novu lozinku",
    "en": "Save new password",
    "ru": "Сохранить новый пароль"
  },
  "auth.signInUnavailable": {
    "sr": "Prijava trenutno nije dostupna",
    "en": "Sign in is currently unavailable",
    "ru": "Вход временно недоступен"
  },
  "auth.signUpUnavailable": {
    "sr": "Registracija trenutno nije dostupna",
    "en": "Registration is currently unavailable",
    "ru": "Регистрация временно недоступна"
  },
  "auth.tryLater": {
    "sr": "Pokušaj ponovo kasnije. Događaje možeš da pregledaš i bez prijave.",
    "en": "Try again later. You can browse events without signing in.",
    "ru": "Попробуйте позже. Просматривать события можно без входа."
  },
  "auth.account": {
    "sr": "Tvoj nalog",
    "en": "Your account",
    "ru": "Ваш аккаунт"
  },
  "profile.saveChoice": {
    "sr": "Sačuvaj svoj izbor",
    "en": "Keep your choices",
    "ru": "Сохраните свой выбор"
  },
  "profile.signInSync": {
    "sr": "Prijavi se da sačuvane događaje i omiljena mesta vidiš na svim svojim uređajima.",
    "en": "Sign in to see saved events and favourite places on all your devices.",
    "ru": "Войдите, чтобы видеть сохранённые события и любимые места на всех своих устройствах."
  },
  "profile.browseWithoutAccount": {
    "sr": "Događaje možeš da pregledaš i bez naloga.",
    "en": "You can browse events without an account.",
    "ru": "Просматривать события можно без аккаунта."
  },
  "profile.authNotLoaded": {
    "sr": "Prijava se nije učitala",
    "en": "Sign in did not load",
    "ru": "Вход не загрузился"
  },
  "profile.refresh": {
    "sr": "Osveži stranicu i pokušaj ponovo. Događaje možeš da pregledaš i bez prijave.",
    "en": "Refresh the page and try again. You can browse events without signing in.",
    "ru": "Обновите страницу и попробуйте ещё раз. Просматривать события можно без входа."
  },
  "profile.add": {
    "sr": "Dodaj",
    "en": "Add",
    "ru": "Добавить"
  },
  "profile.remind": {
    "sr": "Podseti me pre sačuvanih događaja",
    "en": "Remind me before saved events",
    "ru": "Напоминать о сохранённых событиях"
  },
  "profile.remindHint": {
    "sr": "Podsetnik dva sata pre otvaranja",
    "en": "A nudge two hours before doors",
    "ru": "Напоминание за два часа до открытия"
  },
  "profile.liveJazz": {
    "sr": "Džez uživo",
    "en": "Live jazz",
    "ru": "Живой джаз"
  },
  "profile.freeEvents": {
    "sr": "Besplatni događaji",
    "en": "Free events",
    "ru": "Бесплатные события"
  },
  "install.announcement": {
    "sr": "Instaliraj EventZeka App. Predlog se zatvara za 10 sekundi. Uputstvo je uvek dostupno na stranici profila.",
    "en": "Install EventZeka App. This suggestion closes in 10 seconds. Instructions are always available on your profile page.",
    "ru": "Установите EventZeka App. Предложение закроется через 10 секунд. Инструкция всегда доступна на странице профиля."
  },
  "install.installApp": {
    "sr": "Instaliraj EventZeka App",
    "en": "Install EventZeka App",
    "ru": "Установить EventZeka App"
  },
  "install.computer": {
    "sr": "Računar",
    "en": "Computer",
    "ru": "Компьютер"
  },
  "install.iosNote": {
    "sr": "U Safariju na iPhone-u",
    "en": "In Safari on iPhone",
    "ru": "В Safari на iPhone"
  },
  "install.shareTitle": {
    "sr": "Otvori deljenje",
    "en": "Open sharing",
    "ru": "Откройте меню отправки"
  },
  "install.safariDiagram": {
    "sr": "Ilustracija Safari menija: izaberi Share, ikonicu deljenja.",
    "en": "Safari menu illustration: choose Share, the sharing icon.",
    "ru": "Пример меню Safari: выберите Share, значок отправки."
  },
  "install.tapHere": {
    "sr": "Dodirni ovde",
    "en": "Tap here",
    "ru": "Нажмите здесь"
  },
  "install.shareBefore": {
    "sr": "Dodirni",
    "en": "Tap",
    "ru": "Нажмите"
  },
  "install.shareAfter": {
    "sr": "Ako ga ne vidiš, otvori meni stranice pa izaberi Share.",
    "en": "If you cannot see it, open the page menu and choose Share.",
    "ru": "Если значка нет, откройте меню страницы и выберите Share."
  },
  "install.addHome": {
    "sr": "Dodaj na početni ekran",
    "en": "Add to Home Screen",
    "ru": "Добавьте на главный экран"
  },
  "install.shareDiagram": {
    "sr": "Ilustracija liste deljenja: izaberi Add to Home Screen.",
    "en": "Share sheet illustration: choose Add to Home Screen.",
    "ru": "Пример меню отправки: выберите Add to Home Screen."
  },
  "install.findInList": {
    "sr": "U listi pronađi",
    "en": "In the list, find",
    "ru": "Найдите в списке"
  },
  "install.scrollList": {
    "sr": "Po potrebi pomeri listu nadole.",
    "en": "Scroll down the list if needed.",
    "ru": "При необходимости прокрутите список вниз."
  },
  "install.confirmAdd": {
    "sr": "Potvrdi dodavanje",
    "en": "Confirm adding",
    "ru": "Подтвердите добавление"
  },
  "install.iosConfirmDiagram": {
    "sr": "Ilustracija potvrde: Open as Web App je uključeno, a Add potvrđuje dodavanje.",
    "en": "Confirmation illustration: Open as Web App is enabled and Add confirms adding.",
    "ru": "Пример подтверждения: Open as Web App включено, а Add подтверждает добавление."
  },
  "install.ifShown": {
    "sr": "Ako se prikazuje",
    "en": "If you see",
    "ru": "Если отображается"
  },
  "install.keepEnabled": {
    "sr": "ostavi uključeno. Zatim dodirni",
    "en": "leave it enabled. Then tap",
    "ru": "оставьте включённым. Затем нажмите"
  },
  "install.iosFootnote": {
    "sr": "Ilustracije menija. Nazivi i raspored zavise od verzije i jezika iOS-a.",
    "en": "Illustrative menus. Labels and layout depend on your iOS version and language.",
    "ru": "Примеры меню. Названия и расположение зависят от версии и языка iOS."
  },
  "install.androidNote": {
    "sr": "U Chrome-u na Android telefonu",
    "en": "In Chrome on an Android phone",
    "ru": "В Chrome на телефоне Android"
  },
  "install.openChrome": {
    "sr": "Otvori Chrome meni",
    "en": "Open the Chrome menu",
    "ru": "Откройте меню Chrome"
  },
  "install.androidMenuDiagram": {
    "sr": "Ilustracija Chrome adresne trake: otvori meni sa tri tačke.",
    "en": "Chrome address bar illustration: open the three-dot menu.",
    "ru": "Пример адресной строки Chrome: откройте меню с тремя точками."
  },
  "install.androidOpen": {
    "sr": "Na sajtu eventzeka.com dodirni tri tačke u Chrome-u.",
    "en": "On eventzeka.com, tap the three dots in Chrome.",
    "ru": "На сайте eventzeka.com нажмите три точки в Chrome."
  },
  "install.findInstall": {
    "sr": "Pronađi instaliranje",
    "en": "Find the installation option",
    "ru": "Найдите установку"
  },
  "install.chromeInstallDiagram": {
    "sr": "Ilustracija Chrome menija: izaberi Install and create shortcut.",
    "en": "Chrome menu illustration: choose Install and create shortcut.",
    "ru": "Пример меню Chrome: выберите Install and create shortcut."
  },
  "install.choose": {
    "sr": "Izaberi",
    "en": "Choose",
    "ru": "Выберите"
  },
  "install.chromeVersions": {
    "sr": "U nekim verzijama piše Install app ili Add to Home screen.",
    "en": "Some versions call it Install app or Add to Home screen.",
    "ru": "В некоторых версиях пункт называется Install app или Add to Home screen."
  },
  "install.confirmInstall": {
    "sr": "Potvrdi instaliranje",
    "en": "Confirm installation",
    "ru": "Подтвердите установку"
  },
  "install.androidConfirmDiagram": {
    "sr": "Ilustracija potvrde za Event Zeka: izaberi Install.",
    "en": "Event Zeka confirmation illustration: choose Install.",
    "ru": "Пример подтверждения Event Zeka: выберите Install."
  },
  "install.tap": {
    "sr": "Dodirni",
    "en": "Tap",
    "ru": "Нажмите"
  },
  "install.androidConfirm": {
    "sr": "i prati potvrdu telefona. Ako nudi samo prečicu, potvrdi dodavanje prečice.",
    "en": "and follow your phone's confirmation. If it only offers a shortcut, confirm adding the shortcut.",
    "ru": "и следуйте указаниям телефона. Если предлагается только ярлык, подтвердите его добавление."
  },
  "install.androidFootnote": {
    "sr": "Ilustracije menija. Dostupna opcija zavisi od Chrome-a i uređaja.",
    "en": "Illustrative menus. The available option depends on Chrome and your device.",
    "ru": "Примеры меню. Доступный вариант зависит от Chrome и устройства."
  },
  "install.desktopNote": {
    "sr": "Chrome na računaru",
    "en": "Chrome on a computer",
    "ru": "Chrome на компьютере"
  },
  "install.openWebsite": {
    "sr": "Otvori eventzeka.com",
    "en": "Open eventzeka.com",
    "ru": "Откройте eventzeka.com"
  },
  "install.desktopOpen": {
    "sr": "U Chrome-u otvori meni sa tri tačke.",
    "en": "In Chrome, open the three-dot menu.",
    "ru": "В Chrome откройте меню с тремя точками."
  },
  "install.desktopMenuDiagram": {
    "sr": "Ilustracija Chrome menija: Cast, save, and share, pa Install page as app.",
    "en": "Chrome menu illustration: Cast, save, and share, then Install page as app.",
    "ru": "Пример меню Chrome: Cast, save, and share, затем Install page as app."
  },
  "install.then": {
    "sr": "pa",
    "en": "then",
    "ru": "затем"
  },
  "install.addressInstall": {
    "sr": "Može biti dostupna i ikonica za instaliranje u adresnoj traci.",
    "en": "An install icon may also be available in the address bar.",
    "ru": "Значок установки также может быть доступен в адресной строке."
  },
  "install.confirmWithInstall": {
    "sr": "Potvrdi sa Install",
    "en": "Confirm with Install",
    "ru": "Подтвердите кнопкой Install"
  },
  "install.openFromApps": {
    "sr": "Event Zeku zatim otvaraš iz liste svojih aplikacija.",
    "en": "You can then open Event Zeka from your apps.",
    "ru": "После этого Event Zeka можно открыть из списка приложений."
  },
  "install.macSafari": {
    "sr": "Koristim Safari na Mac-u",
    "en": "I use Safari on Mac",
    "ru": "Я использую Safari на Mac"
  },
  "install.macHelp": {
    "sr": "Na macOS Sonoma 14 ili novijem: Share → Add to Dock → Add. Naziv i adresu proveri pre potvrde.",
    "en": "On macOS Sonoma 14 or later: Share → Add to Dock → Add. Check the name and address before confirming.",
    "ru": "В macOS Sonoma 14 и новее: Share → Add to Dock → Add. Проверьте название и адрес перед подтверждением."
  },
  "install.desktopFootnote": {
    "sr": "Ilustracija Chrome menija. Opcije mogu da se razlikuju.",
    "en": "Chrome menu illustration. Available options may differ.",
    "ru": "Пример меню Chrome. Доступные варианты могут отличаться."
  },
  "install.iconAlt": {
    "sr": "EventZeka App ikonica",
    "en": "EventZeka App icon",
    "ru": "Значок EventZeka App"
  },
  "install.install": {
    "sr": "Instaliraj",
    "en": "Install",
    "ru": "Установите"
  },
  "install.pickDevice": {
    "sr": "Izaberi uređaj i prati korake.",
    "en": "Choose your device and follow the steps.",
    "ru": "Выберите устройство и следуйте инструкции."
  },
  "install.differentOption": {
    "sr": "Ne vidiš istu opciju?",
    "en": "Do you see a different option?",
    "ru": "Не видите такой пункт?"
  },
  "install.fromInstagram": {
    "sr": "Otvorio/la sam sajt iz Instagrama",
    "en": "I opened the site from Instagram",
    "ru": "Я открыл сайт из Instagram"
  },
  "install.externalBrowser": {
    "sr": "U meniju Instagrama izaberi otvaranje u spoljašnjem pregledaču. Nastavi u Safariju na iPhone-u ili Chrome-u na Androidu.",
    "en": "In the Instagram menu, choose to open in an external browser. Continue in Safari on iPhone or Chrome on Android.",
    "ru": "В меню Instagram выберите открытие во внешнем браузере. Продолжите в Safari на iPhone или Chrome на Android."
  },
  "install.whatIsApp": {
    "sr": "Šta je EventZeka App?",
    "en": "What is EventZeka App?",
    "ru": "Что такое EventZeka App?"
  },
  "install.appDefinition": {
    "sr": "EventZeka App je web aplikacija koja se dodaje iz pregledača. Za pregled događaja potreban je internet.",
    "en": "EventZeka App is a web app added from your browser. An internet connection is needed to browse events.",
    "ru": "EventZeka App — веб-приложение, которое добавляется из браузера. Для просмотра событий нужен интернет."
  },
  "install.officialHelp": {
    "sr": "Gde su zvanična uputstva?",
    "en": "Where are the official instructions?",
    "ru": "Где найти официальные инструкции?"
  },
  "install.googleDesktop": {
    "sr": "Google: računar",
    "en": "Google: computer",
    "ru": "Google: компьютер"
  }
} as const;

export type AccountMessageKey = keyof typeof accountMessages;

export function accountText(locale: Locale, key: AccountMessageKey, values: Record<string, string | number> = {}): string {
  const message = accountMessages[key][locale] as string;
  return message.replace(/\{([a-zA-Z][a-zA-Z0-9_]*)\}/g, (placeholder, name: string) =>
    Object.prototype.hasOwnProperty.call(values, name) ? String(values[name]) : placeholder,
  );
}
