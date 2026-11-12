# GymLog · Personal Gym Tracker

GymLog ist eine mobile-first Trainings-Web-App. Die Daten werden ausschließlich lokal in IndexedDB des Browsers gespeichert. Es gibt keine Konten, Cloud-Datenbank oder Synchronisierung.

## Veröffentlichung
Das Repository ist für GitHub Pages unter https://ericbrunckhorst.github.io/gymlog/ vorbereitet. Jeder Push auf main startet automatisch den Build und die Veröffentlichung. Unter Settings → Pages muss als Quelle gegebenenfalls **GitHub Actions** gewählt werden.

## Auf dem iPhone installieren
1. Die HTTPS-Adresse in Safari öffnen.
2. Teilen → „Zum Home-Bildschirm“.
3. GymLog einmal online öffnen, damit App-Shell und Service Worker geladen werden.

## Daten und Datenschutz
- Primärer Speicher: IndexedDB, Datenbank gymlog-local.
- Keine externen Analyse- oder Laufzeitdienste.
- Export/Import über JSON im Bereich Verlauf → Datensicherung.
- Website-Daten löschen kann lokale Daten entfernen. Regelmäßig exportieren.

## Funktionsumfang
- Push/Pull/Beine-Pläne und eigene Übungen
- Variable Sätze je Training
- Letzte Werte je Übung übernehmen
- Automatisches Speichern des laufenden Trainings
- Trainingsverlauf und Statistiken
- JSON-Backup, Import und Zurücksetzen
- Service Worker und Web-App-Manifest

Ein echter iPhone-/Safari-Abnahmetest steht noch aus.
