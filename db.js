'use strict';
// IndexedDB の薄いラッパー。データは端末内（ブラウザ内）にだけ保存される。
//   exercises: 種目マスタ { id, part, name, kind, order }
//   entries  : 1日の中の1種目の記録 { id, date, exerciseId, part, name, kind, sets: [...], order }
//   days     : 日ごとのメモ { date, memo }

// kind: weight=重さ×回数 / reps=回数のみ / time=秒 / cardio=時間・距離
const DEFAULT_EXERCISES = [
  ['chest', 'ベンチプレス', 'weight'], ['chest', 'ダンベルプレス', 'weight'], ['chest', 'インクラインベンチプレス', 'weight'],
  ['chest', 'ダンベルフライ', 'weight'], ['chest', 'チェストプレス', 'weight'], ['chest', '腕立て伏せ', 'reps'],
  ['back', 'デッドリフト', 'weight'], ['back', 'ラットプルダウン', 'weight'], ['back', 'ベントオーバーロー', 'weight'],
  ['back', 'シーテッドロー', 'weight'], ['back', '懸垂', 'reps'],
  ['shoulder', 'ショルダープレス', 'weight'], ['shoulder', 'サイドレイズ', 'weight'], ['shoulder', 'フロントレイズ', 'weight'],
  ['shoulder', 'リアレイズ', 'weight'],
  ['arm', 'アームカール', 'weight'], ['arm', 'ハンマーカール', 'weight'], ['arm', 'トライセプスエクステンション', 'weight'],
  ['arm', 'ディップス', 'reps'],
  ['leg', 'スクワット', 'weight'], ['leg', 'レッグプレス', 'weight'], ['leg', 'ランジ', 'weight'],
  ['leg', 'レッグエクステンション', 'weight'], ['leg', 'レッグカール', 'weight'], ['leg', 'カーフレイズ', 'weight'],
  ['abs', 'クランチ', 'reps'], ['abs', 'レッグレイズ', 'reps'], ['abs', 'アブローラー', 'reps'], ['abs', 'プランク', 'time'],
  ['cardio', 'ランニング', 'cardio'], ['cardio', 'ウォーキング', 'cardio'], ['cardio', 'バイク', 'cardio'], ['cardio', '縄跳び', 'cardio'],
].map(([part, name, kind], i) => ({ id: `default-${i + 1}`, part, name, kind, order: i }));

const DB = (() => {
  const NAME = 'workout-log';
  const VERSION = 1;
  let dbPromise;

  function open() {
    if (!dbPromise) {
      dbPromise = new Promise((resolve, reject) => {
        const req = indexedDB.open(NAME, VERSION);
        req.onupgradeneeded = () => {
          const db = req.result;
          if (!db.objectStoreNames.contains('exercises')) {
            const s = db.createObjectStore('exercises', { keyPath: 'id' });
            DEFAULT_EXERCISES.forEach(x => s.put(x));
          }
          if (!db.objectStoreNames.contains('entries')) {
            const s = db.createObjectStore('entries', { keyPath: 'id' });
            s.createIndex('date', 'date');
            s.createIndex('exerciseId', 'exerciseId');
          }
          if (!db.objectStoreNames.contains('days')) db.createObjectStore('days', { keyPath: 'date' });
        };
        req.onsuccess = () => {
          const db = req.result;
          db.onversionchange = () => { db.close(); dbPromise = null; };
          resolve(db);
        };
        req.onerror = () => { dbPromise = null; reject(req.error); };
      });
    }
    return dbPromise;
  }

  const wrap = req => new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  async function store(name, mode) {
    const db = await open();
    return db.transaction(name, mode).objectStore(name);
  }

  return {
    all: async s => wrap((await store(s, 'readonly')).getAll()),
    get: async (s, key) => wrap((await store(s, 'readonly')).get(key)),
    put: async (s, val) => wrap((await store(s, 'readwrite')).put(val)),
    del: async (s, key) => wrap((await store(s, 'readwrite')).delete(key)),
    byIndex: async (s, index, val) => wrap((await store(s, 'readonly')).index(index).getAll(val)),
  };
})();
