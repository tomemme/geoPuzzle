# GeoPuzzle Walks

Minimal React PWA for creating walking routes that auto-collect puzzle pieces by GPS proximity.

## Quickstart

```bash
npm install
npm run dev
```

## Environment

Copy `.env.example` to `.env` and set Supabase keys if you want backend storage.

## Notes

- Walk Mode uses browser geolocation and stores only collected piece IDs in localStorage.
- Admin Mode lets you drop pieces and export/import route JSON.
