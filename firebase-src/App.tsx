import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { onAuthStateChanged, signInWithPopup, signOut, type User } from "firebase/auth";
import { doc, getDoc, serverTimestamp, setDoc } from "firebase/firestore";
import { auth, db, googleProvider } from "./firebase";

type Split = "Push" | "Pull" | "Beine";
type Exercise = { id: string; name: string };
type PlanItem = { id: string; exerciseId: string; name: string; sets: number };
type Plan = { id: string; name: Split; items: PlanItem[] };
type WorkoutSet = { id: string; weight: string; reps: string; done: boolean };
type WorkoutExercise = { id: string; planItemId?: string; exerciseId: string; name: string; sets: WorkoutSet[] };
type Session = { id: string; type: Split; startedAt: string; endedAt: string; durationSeconds?: number; exercises: WorkoutExercise[]; completed: boolean };
type AppData = { exercises: Exercise[]; plans: Plan[]; history: Session[]; active: Session | null; persistSetChanges: boolean };

const uid = () => crypto.randomUUID();
const emptySet = (): WorkoutSet => ({ id: uid(), weight: "", reps: "", done: false });
const defaultData = (): AppData => {
  const seed: Exercise[] = [
    "Bankdrücken", "Schrägbankdrücken", "Schulterdrücken", "Seitheben", "Trizepsdrücken",
    "Klimmzüge", "Latzug", "Rudern", "Bizepscurls", "Face Pulls",
    "Kniebeugen", "Beinpresse", "Beinbeuger", "Beinstrecker", "Wadenheben"
  ].map(name => ({ id: uid(), name }));
  return {
    exercises: seed,
    plans: (["Push", "Pull", "Beine"] as Split[]).map(name => ({ id: uid(), name, items: [] })),
    history: [], active: null, persistSetChanges: false
  };
};

const DB_NAME = "gymlog-local";
const DB_VERSION = 1;
function openDB(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains("app")) db.createObjectStore("app");
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}
async function readData(): Promise<AppData | null> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction("app", "readonly");
    const req = tx.objectStore("app").get("state");
    req.onsuccess = () => { db.close(); resolve(req.result ?? null); };
    req.onerror = () => { db.close(); reject(req.error); };
  });
}
async function writeData(data: AppData): Promise<void> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction("app", "readwrite");
    tx.objectStore("app").put(data, "state");
    tx.oncomplete = () => { db.close(); resolve(); };
    tx.onerror = () => { db.close(); reject(tx.error); };
    tx.onabort = () => { db.close(); reject(tx.error); };
  });
}
async function readCloudEnabled(userId: string): Promise<boolean> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction("app", "readonly");
    const req = tx.objectStore("app").get(`cloud-enabled-${userId}`);
    req.onsuccess = () => { db.close(); resolve(req.result === true); };
    req.onerror = () => { db.close(); reject(req.error); };
  });
}
async function writeCloudEnabled(userId: string): Promise<void> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction("app", "readwrite");
    tx.objectStore("app").put(true, `cloud-enabled-${userId}`);
    tx.oncomplete = () => { db.close(); resolve(); };
    tx.onerror = () => { db.close(); reject(tx.error); };
    tx.onabort = () => { db.close(); reject(tx.error); };
  });
}
const dateLabel = (iso: string) => new Date(iso).toLocaleString("de-DE", { dateStyle: "medium", timeStyle: "short" });
const validNumber = (value: string) => value.trim() === "" || (Number.isFinite(Number(value)) && Number(value) >= 0);
const isObject = (value: unknown): value is Record<string, any> => typeof value === "object" && value !== null && !Array.isArray(value);
function isValidBackup(value: unknown): value is AppData {
  if (!isObject(value) || !Array.isArray(value.exercises) || !Array.isArray(value.plans) || !Array.isArray(value.history)) return false;
  if (!value.exercises.every((e: any) => isObject(e) && typeof e.id === "string" && typeof e.name === "string")) return false;
  if (value.plans.length !== 3 || !["Push", "Pull", "Beine"].every(name => value.plans.some((p: any) => p?.name === name)) || !value.plans.every((p: any) => isObject(p) && ["Push", "Pull", "Beine"].includes(p.name) && Array.isArray(p.items) && p.items.every((i: any) => isObject(i) && typeof i.id === "string" && typeof i.exerciseId === "string" && typeof i.name === "string" && Number.isInteger(i.sets) && i.sets >= 1 && i.sets <= 1000))) return false;
  const validSession = (s: any) => isObject(s) && typeof s.id === "string" && ["Push", "Pull", "Beine"].includes(s.type) && typeof s.startedAt === "string" && !Number.isNaN(Date.parse(s.startedAt)) && Array.isArray(s.exercises) && s.exercises.every((e: any) => isObject(e) && typeof e.id === "string" && typeof e.exerciseId === "string" && typeof e.name === "string" && Array.isArray(e.sets) && e.sets.every((st: any) => isObject(st) && typeof st.id === "string" && typeof st.weight === "string" && validNumber(st.weight) && typeof st.reps === "string" && /^\d*$/.test(st.reps) && typeof st.done === "boolean"));
  if (!value.history.every(validSession) || (value.active !== null && value.active !== undefined && !validSession(value.active))) return false;
  return true;
}

export default function App() {
  const [data, setData] = useState<AppData | null>(null);
  const [tab, setTab] = useState<"Training" | "Pläne" | "Statistik" | "Verlauf">("Training");
  const [notice, setNotice] = useState("");
  const [planEdit, setPlanEdit] = useState<Split>("Push");
  const [newExercise, setNewExercise] = useState("");
  const [editingName, setEditingName] = useState<string | null>(null);
  const [selectedStatsExercise, setSelectedStatsExercise] = useState("");
  const [selectedHistory, setSelectedHistory] = useState<string | null>(null);
  const importRef = useRef<HTMLInputElement>(null);
  const [ready, setReady] = useState(false);
  const [storageAvailable, setStorageAvailable] = useState(true);
  const [finishing, setFinishing] = useState(false);
  const [user, setUser] = useState<User | null>(null);
  const [cloudChoice, setCloudChoice] = useState<"idle" | "choose" | "enabled" | "blocked">("idle");
  const [cloudStatus, setCloudStatus] = useState("Nicht verbunden");
  const [pendingCloud, setPendingCloud] = useState<AppData | null>(null);
  const [cloudBusy, setCloudBusy] = useState(false);
  const cloudTimer = useRef<number | null>(null);

  useEffect(() => onAuthStateChanged(auth, nextUser => {
    setUser(nextUser);
    setCloudChoice("idle");
    setPendingCloud(null);
    setCloudStatus(nextUser ? "Cloud wird geprüft…" : "Nicht verbunden");
  }), []);

  useEffect(() => {
    if (!user || !ready || !data || cloudChoice !== "idle") return;
    let cancelled = false;
    const checkCloud = async () => {
      const enabledKey = `gymlog-cloud-enabled-${user.uid}`;
      let enabled = false;
      try { enabled = await readCloudEnabled(user.uid); }
      catch (error) { console.warn("Cloud-Einstellung konnte nicht aus dem lokalen Speicher gelesen werden.", error); }
      try { enabled = enabled || localStorage.getItem(enabledKey) === "1"; }
      catch (error) { console.warn("Cloud-Einstellung konnte nicht aus localStorage gelesen werden.", error); }
      if (cancelled) return;
      if (enabled) {
        setCloudChoice("enabled");
        setCloudStatus("Cloud-Synchronisierung aktiv");
        return;
      }
      setCloudStatus("Cloud-Backup wird geprüft…");
      try {
        const snapshot = await getDoc(doc(db, "users", user.uid, "backups", "main"));
        if (cancelled) return;
        if (snapshot.exists()) {
          if (snapshot.data().cloudEnabled === true) {
            await writeCloudEnabled(user.uid).catch(error => console.warn("Cloud-Status konnte lokal nicht gespeichert werden.", error));
            try { localStorage.setItem(enabledKey, "1"); } catch (error) { console.warn("Cloud-Einstellung konnte nicht aus localStorage gespeichert werden.", error); }
            setCloudChoice("enabled");
            setCloudStatus("Cloud-Synchronisierung aktiv");
            return;
          }
          const remote = snapshot.data().data;
          if (isValidBackup(remote)) {
            setPendingCloud(remote);
            setCloudChoice("choose");
            setCloudStatus("Entscheidung erforderlich");
          } else {
            setCloudChoice("blocked");
            setCloudStatus("Cloud-Backup hat ein unbekanntes Format");
            setNotice("Das Cloud-Backup hat ein unbekanntes Format. Deine lokalen Daten bleiben unverändert.");
          }
        } else {
          setPendingCloud(null);
          setCloudChoice("choose");
          setCloudStatus("Noch kein Cloud-Backup");
        }
      } catch (error) {
        if (cancelled) return;
        console.error(error);
        setCloudStatus("Cloud-Prüfung fehlgeschlagen");
        setNotice("Cloud-Backup konnte nicht geprüft werden. Deine lokalen Daten sind weiterhin verfügbar.");
      }
    };
    checkCloud();
    return () => { cancelled = true; };
  }, [user, ready, data, cloudChoice]);

  useEffect(() => {
    if (!user || !data || cloudChoice !== "enabled") return;
    setCloudStatus("Cloud-Sicherung läuft…");
    if (cloudTimer.current !== null) window.clearTimeout(cloudTimer.current);
    cloudTimer.current = window.setTimeout(() => {
      setDoc(doc(db, "users", user.uid, "backups", "main"), {
        data, updatedAt: serverTimestamp(), appVersion: 1, cloudEnabled: true
      }).then(() => setCloudStatus("Cloud gesichert"))
        .catch(error => { console.error(error); setCloudStatus("Cloud-Sicherung fehlgeschlagen"); });
    }, 1200);
    return () => { if (cloudTimer.current !== null) window.clearTimeout(cloudTimer.current); };
  }, [data, user, cloudChoice]);

  async function connectGoogle() {
    setCloudBusy(true);
    try { await signInWithPopup(auth, googleProvider); }
    catch (error) { console.error(error); setNotice("Google-Anmeldung fehlgeschlagen. Bitte erneut versuchen."); }
    finally { setCloudBusy(false); }
  }
  async function chooseLocalForCloud() {
    if (!user || !data) return;
    setCloudBusy(true);
    try {
      await setDoc(doc(db, "users", user.uid, "backups", "main"), { data, updatedAt: serverTimestamp(), appVersion: 1, cloudEnabled: true });
      await writeCloudEnabled(user.uid);
      try { localStorage.setItem(`gymlog-cloud-enabled-${user.uid}`, "1"); } catch (error) { console.warn("Cloud-Einstellung konnte nicht in localStorage gespeichert werden.", error); }
      setPendingCloud(null); setCloudChoice("enabled"); setCloudStatus("Cloud gesichert");
      setNotice("Deine lokalen GymLog-Daten sind jetzt in der Cloud gesichert.");
    } catch (error) { console.error(error); setCloudStatus("Sicherung fehlgeschlagen"); setNotice("Cloud-Sicherung fehlgeschlagen. Deine lokalen Daten bleiben erhalten."); }
    finally { setCloudBusy(false); }
  }
  async function restoreCloudBackup() {
    if (!pendingCloud) return;
    if (!window.confirm("Das Cloud-Backup ersetzt die Daten auf diesem Gerät. Möchtest du fortfahren?")) return;
    setCloudBusy(true);
    try {
      await writeData(pendingCloud); setData(pendingCloud);
      if (user) {
        await setDoc(doc(db, "users", user.uid, "backups", "main"), { cloudEnabled: true }, { merge: true });
        await writeCloudEnabled(user.uid);
        try { localStorage.setItem(`gymlog-cloud-enabled-${user.uid}`, "1"); } catch (error) { console.warn("Cloud-Einstellung konnte nicht in localStorage gespeichert werden.", error); }
      }
      setCloudChoice("enabled");
      setCloudStatus("Cloud-Backup wiederhergestellt"); setNotice("Cloud-Backup erfolgreich wiederhergestellt.");
    } catch (error) { console.error(error); setNotice("Wiederherstellung fehlgeschlagen. Lokale Daten wurden nicht absichtlich überschrieben."); }
    finally { setCloudBusy(false); }
  }
  async function useLocalAndReplaceCloud() {
    if (pendingCloud && !window.confirm("Das vorhandene Cloud-Backup wird durch die Daten dieses Geräts ersetzt. Wirklich fortfahren?")) return;
    await chooseLocalForCloud();
  }

  useEffect(() => {
    readData().then(saved => {
      if (saved) setData(saved);
      else {
        const fresh = defaultData();
        setData(fresh);
        writeData(fresh).catch(console.error);
      }
      setReady(true);
    }).catch(() => {
      const fresh = defaultData();
      setData(fresh);
      setStorageAvailable(false);
      setReady(true);
      setNotice("Lokaler Speicher ist nicht verfügbar. Änderungen bleiben möglicherweise nicht erhalten.");
    });
  }, []);

  useEffect(() => {
    if (!data || !ready) return;
    writeData(data).then(() => setStorageAvailable(true)).catch(() => { setStorageAvailable(false); setNotice("Speichern fehlgeschlagen. Bitte Speicherplatz prüfen und Export versuchen."); });
  }, [data, ready]);

  useEffect(() => {
    if (ready && navigator.storage?.persist) navigator.storage.persist().catch(() => undefined);
  }, [ready]);

  const update = useCallback((fn: (current: AppData) => AppData) => {
    setData(current => current ? fn(current) : current);
  }, []);

  const plan = useMemo(() => data?.plans.find(p => p.name === planEdit), [data, planEdit]);
  const active = data?.active ?? null;

  const lastFor = (exerciseId: string, planItemId?: string) => {
    if (!data) return null;
    for (const session of [...data.history].sort((a, b) => b.startedAt.localeCompare(a.startedAt))) {
      const ex = (planItemId ? session.exercises.find(e => e.planItemId === planItemId) : undefined)
        ?? session.exercises.find(e => e.exerciseId === exerciseId);
      if (ex) return ex;
    }
    return null;
  };

  function startWorkout(split: Split) {
    if (!data) return;
    if (data.active && !window.confirm("Es läuft bereits ein Training. Dieses Training verwerfen und den neuen Plan starten?")) return;
    const p = data.plans.find(item => item.name === split);
    if (!p || p.items.length === 0) {
      setTab("Pläne"); setPlanEdit(split); setNotice(`Richte zuerst deinen ${split}-Plan ein.`);
      return;
    }
    const exercises = p.items.map(item => ({
      id: uid(), planItemId: item.id, exerciseId: item.exerciseId, name: item.name,
      sets: Array.from({ length: Math.max(1, item.sets) }, () => emptySet())
    }));
    const next = { ...data, active: { id: uid(), type: split, startedAt: new Date().toISOString(), endedAt: "", exercises, completed: false } };
    setData(next);
    writeData(next).then(() => setStorageAvailable(true)).catch(() => {
      setStorageAvailable(false);
      setNotice("Das Training konnte nicht lokal gespeichert werden. Bitte Speicher prüfen.");
    });
    setTab("Training");
  }

  function patchActive(fn: (session: Session) => Session) {
    if (!data?.active) return;
    const next = { ...data, active: fn(data.active) };
    setData(next);
    // Write from the interaction itself as well as the state effect, reducing the
    // window in which a fast Safari close could lose the most recent set edit.
    writeData(next).then(() => setStorageAvailable(true)).catch(() => {
      setStorageAvailable(false);
      setNotice("Speichern fehlgeschlagen. Bitte Speicher prüfen und deine Daten exportieren.");
    });
  }
  function updateSet(exId: string, setId: string, patch: Partial<WorkoutSet>) {
    patchActive(s => ({ ...s, exercises: s.exercises.map(e => e.id === exId ? {
      ...e, sets: e.sets.map(st => st.id === setId ? { ...st, ...patch } : st)
    } : e) }));
  }
  async function finishWorkout() {
    if (!active || !data || finishing) return;
    setFinishing(true);
    const endedAt = new Date().toISOString();
    const finished: Session = { ...active, endedAt, durationSeconds: Math.max(0, Math.round((new Date(endedAt).getTime() - new Date(active.startedAt).getTime()) / 1000)), completed: active.exercises.every(e => e.sets.length > 0 && e.sets.every(s => s.done)) };
    const next: AppData = { ...data, history: [finished, ...data.history], active: null };
    if (data.persistSetChanges) {
      next.plans = data.plans.map(p => p.name !== finished.type ? p : {
        ...p, items: p.items.map(item => {
          const performed = finished.exercises.find(e => e.planItemId === item.id);
          return performed ? { ...item, sets: performed.sets.length } : item;
        })
      });
    }
    try {
      await writeData(next);
      setData(next);
      setNotice("Training wurde im Verlauf gespeichert.");
      setTab("Verlauf");
    } catch {
      setNotice("Speichern fehlgeschlagen. Dein Training bleibt geöffnet. Bitte Speicher prüfen und erneut versuchen.");
    } finally {
      setFinishing(false);
    }
  }

  function addPlanExercise(exercise: Exercise) {
    if (!plan) return;
    update(d => ({ ...d, plans: d.plans.map(p => p.name !== planEdit ? p : {
      ...p, items: [...p.items, { id: uid(), exerciseId: exercise.id, name: exercise.name, sets: 2 }]
    }) }));
  }
  function createExercise() {
    const name = newExercise.trim();
    if (!name || !data) return;
    const existing = data.exercises.find(e => e.name.toLocaleLowerCase() === name.toLocaleLowerCase());
    const exercise = existing ?? { id: uid(), name };
    update(d => ({ ...d, exercises: existing ? d.exercises : [...d.exercises, exercise], plans: d.plans.map(p => p.name !== planEdit ? p : {
      ...p, items: [...p.items, { id: uid(), exerciseId: exercise.id, name, sets: 2 }]
    }) }));
    setNewExercise("");
  }
  function changePlanItem(itemId: string, patch: Partial<PlanItem>) {
    if (patch.name !== undefined && !patch.name.trim()) return;
    update(d => ({ ...d, plans: d.plans.map(p => p.name !== planEdit ? p : { ...p, items: p.items.map(i => i.id === itemId ? { ...i, ...patch } : i) }) }));
  }
  function movePlanItem(itemId: string, direction: -1 | 1) {
    update(d => ({ ...d, plans: d.plans.map(p => {
      if (p.name !== planEdit) return p;
      const items = [...p.items], index = items.findIndex(i => i.id === itemId), target = index + direction;
      if (target < 0 || target >= items.length) return p;
      [items[index], items[target]] = [items[target], items[index]];
      return { ...p, items };
    }) }));
  }

  function exportData() {
    if (!data) return;
    const blob = new Blob([JSON.stringify({ format: "GymLog", version: 1, exportedAt: new Date().toISOString(), data }, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob), a = document.createElement("a");
    a.href = url; a.download = `gymlog-backup-${new Date().toISOString().slice(0, 10)}.json`; a.click();
    window.setTimeout(() => URL.revokeObjectURL(url), 1500);
  }
  async function importData(file?: File) {
    if (!file) return;
    try {
      const parsed = JSON.parse(await file.text());
      const incoming = parsed?.data;
      if (parsed?.format !== "GymLog" || parsed?.version !== 1 || !isValidBackup(incoming)) {
        throw new Error("Ungültiges oder beschädigtes GymLog-Backup. Deine vorhandenen Daten wurden nicht verändert.");
      }
      if (!window.confirm("Import ersetzt deine aktuell gespeicherten Daten vollständig. Fortfahren?")) return;
      const safe: AppData = { exercises: incoming.exercises, plans: incoming.plans, history: incoming.history, active: incoming.active ?? null, persistSetChanges: Boolean(incoming.persistSetChanges) };
      await writeData(safe); setData(safe); setNotice("Backup erfolgreich importiert.");
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "Import fehlgeschlagen.");
    } finally {
      if (importRef.current) importRef.current.value = "";
    }
  }
  async function deleteAll() {
    if (!window.confirm("Wirklich ALLE Trainingspläne, Übungen, Trainings und Einstellungen löschen? Dieser Schritt kann nicht rückgängig gemacht werden.")) return;
    const fresh = defaultData();
    try {
      await writeData(fresh);
      setData(fresh);
      setSelectedHistory(null);
      setNotice("Alle Daten wurden gelöscht.");
    } catch {
      setNotice("Daten konnten nicht gelöscht werden. Bitte Speicher prüfen und erneut versuchen.");
    }
  }

  if (!ready || !data) return <div className="loading">GymLog wird geladen…</div>;

  const completedExercises = active?.exercises.filter(e => e.sets.length > 0 && e.sets.every(s => s.done)).length ?? 0;
  const selectedSession = data.history.find(s => s.id === selectedHistory);
  const allExerciseOptions = data.exercises;

  return <div className="app-shell">
    <header className="topbar">
      <div className="brand"><span className="brand-mark">G</span><span>GymLog</span></div>
      <div className="save-state"><span className={`online-dot ${storageAvailable ? "" : "storage-error"}`} /> {storageAvailable ? (cloudChoice === "enabled" ? cloudStatus : "Lokal gespeichert") : "Speicher nicht verfügbar"}</div>
    </header>

    {notice && <button className="notice" onClick={() => setNotice("")}>{notice} <span>×</span></button>}

    <main className="main">
      {tab === "Training" && <section>
        {!active ? <>
          <div className="eyebrow">BEREIT FÜRS TRAINING?</div>
          <h1>Dein nächstes<br /><span>Workout.</span></h1>
          <p className="muted intro">Wähle deinen Split. Deine gespeicherten Übungen warten bereits.</p>
          <div className="split-grid">
            {(["Push", "Pull", "Beine"] as Split[]).map((split, i) => {
              const count = data.plans.find(p => p.name === split)?.items.length ?? 0;
              return <button className={`split-card split-${i}`} key={split} onClick={() => startWorkout(split)}>
                <span className="split-icon">{["↗", "↙", "⌁"][i]}</span>
                <span className="split-name">{split} trainieren</span>
                <span className="split-meta">{count} Übungen <b>→</b></span>
              </button>;
            })}
          </div>
          <div className="panel quick-panel">
            <div><span className="eyebrow">DEIN TRAININGSPLAN</span><h3>Alles vorbereitet?</h3><p className="muted">Passe Übungen und Sätze einmalig unter „Pläne“ an.</p></div>
            <button className="secondary-btn" onClick={() => setTab("Pläne")}>Pläne bearbeiten</button>
          </div>
          <div className="section-heading"><h2>Zuletzt trainiert</h2><button className="text-btn" onClick={() => setTab("Verlauf")}>Alle ansehen →</button></div>
          {data.history.length === 0 ? <div className="empty">Noch keine Trainings gespeichert. Dein erstes Workout wartet.</div> :
            <div className="history-mini">{data.history.slice(0, 2).map(s => <div className="history-row" key={s.id}><div className="history-badge">{s.type.slice(0,1)}</div><div className="grow"><b>{s.type}</b><small>{dateLabel(s.startedAt)}</small></div><span className="muted">{s.exercises.length} Übungen</span></div>)}</div>}
        </> : <>
          <div className="workout-head">
            <div><button className="back-link" onClick={() => { if (window.confirm("Laufendes Training verlassen? Es bleibt gespeichert und kann später fortgesetzt werden.")) setTab("Verlauf"); }}>← Übersicht</button>
              <div className="eyebrow">LAUFENDES TRAINING</div><h1>{active.type}<span className="green-dot">.</span></h1>
              <p className="muted">{dateLabel(active.startedAt)}</p></div>
            <div className="progress-ring"><b>{completedExercises}</b><span>/{active.exercises.length}</span></div>
          </div>
          <div className="progress-track"><div style={{ width: `${active.exercises.length ? completedExercises / active.exercises.length * 100 : 0}%` }} /></div>
          <p className="progress-label">{completedExercises} von {active.exercises.length} Übungen erledigt</p>
          {active.exercises.map((exercise, index) => {
            const last = lastFor(exercise.exerciseId, exercise.planItemId);
            return <article className="exercise-card" key={exercise.id}>
              <div className="exercise-title"><div><span className="exercise-index">{String(index + 1).padStart(2, "0")}</span><h3>{exercise.name}</h3></div>
                <span className="set-count">{exercise.sets.filter(s => s.done).length}/{exercise.sets.length}</span></div>
              {last && <div className="last-values"><span>LETZTES TRAINING</span><p>{last.sets.map(s => `${s.weight || "–"} kg × ${s.reps || "–"}`).join("  ·  ")}</p>
                <button className="tiny-btn" onClick={() => patchActive(s => ({ ...s, exercises: s.exercises.map(e => e.id !== exercise.id ? e : { ...e, sets: e.sets.map((st, i) => ({ ...st, weight: last.sets[i]?.weight ?? st.weight, reps: last.sets[i]?.reps ?? st.reps })) }) }))}>Werte übernehmen</button></div>}
              <div className="set-head"><span>SATZ</span><span>GEWICHT (KG)</span><span>WIEDERHOLUNGEN</span><span>✓</span></div>
              {exercise.sets.map((set, i) => <div className={`set-row ${set.done ? "is-done" : ""}`} key={set.id}>
                <span className="set-number">{i + 1}</span>
                <input aria-label={`Gewicht Satz ${i + 1}`} type="number" min="0" step="0.25" inputMode="decimal" placeholder="0" value={set.weight} onChange={e => { const value = e.target.value; if (validNumber(value)) updateSet(exercise.id, set.id, { weight: value }); }} />
                <input aria-label={`Wiederholungen Satz ${i + 1}`} type="number" min="0" step="1" inputMode="numeric" placeholder="0" value={set.reps} onChange={e => { const value = e.target.value; if (/^\d*$/.test(value)) updateSet(exercise.id, set.id, { reps: value }); }} />
                <button className={`check-btn ${set.done ? "checked" : ""}`} aria-label="Satz abschließen" onClick={() => updateSet(exercise.id, set.id, { done: !set.done })}>{set.done ? "✓" : ""}</button>
                <button className="remove-set" aria-label="Satz entfernen" onClick={() => { if (exercise.sets.length <= 1) { setNotice("Eine Übung muss mindestens einen Satz behalten."); return; } patchActive(s => ({ ...s, exercises: s.exercises.map(e => e.id === exercise.id ? { ...e, sets: e.sets.filter(st => st.id !== set.id) } : e) })); }}>×</button>
              </div>)}
              <button className="add-set-btn" onClick={() => patchActive(s => ({ ...s, exercises: s.exercises.map(e => e.id === exercise.id ? { ...e, sets: [...e.sets, emptySet()] } : e) }))}>＋ Satz hinzufügen</button>
            </article>;
          })}
          <button className="finish-btn" onClick={finishWorkout} disabled={finishing}>{finishing ? "Wird gespeichert…" : "Training beenden und speichern"} <span>→</span></button>
          <p className="finish-note">Auch unvollständige Einheiten werden gespeichert. Nicht abgehakte Sätze bleiben offen.</p>
        </>}
      </section>}

      {tab === "Pläne" && <section>
        <div className="eyebrow">DEIN SETUP</div><h1>Trainings<span>pläne.</span></h1>
        <p className="muted intro">Einmal einrichten, bei jedem Training wiederverwenden.</p>
        <div className="segmented">{(["Push", "Pull", "Beine"] as Split[]).map(s => <button key={s} className={planEdit === s ? "selected" : ""} onClick={() => setPlanEdit(s)}>{s}</button>)}</div>
        <div className="plan-list">
          {plan?.items.length === 0 && <div className="empty">Noch keine Übungen. Füge unten deine erste Übung hinzu.</div>}
          {plan?.items.map((item, i) => <div className="plan-item" key={item.id}>
            <div className="plan-order"><button disabled={i === 0} onClick={() => movePlanItem(item.id, -1)}>↑</button><span>{i + 1}</span><button disabled={i === (plan.items.length - 1)} onClick={() => movePlanItem(item.id, 1)}>↓</button></div>
            <div className="plan-item-main">
              {editingName === item.id ? <input className="rename-input" autoFocus value={item.name} onChange={e => changePlanItem(item.id, { name: e.target.value })} onBlur={() => setEditingName(null)} onKeyDown={e => { if (e.key === "Enter") setEditingName(null); }} /> :
                <button className="plan-exercise-name" onClick={() => setEditingName(item.id)}>{item.name} <small>Bearbeiten</small></button>}
              <div className="sets-adjust"><span>Standardsätze</span><button onClick={() => changePlanItem(item.id, { sets: Math.max(1, item.sets - 1) })}>−</button><b>{item.sets}</b><button onClick={() => changePlanItem(item.id, { sets: Math.min(1000, item.sets + 1) })}>＋</button></div>
            </div>
            <button className="delete-btn" aria-label="Übung entfernen" onClick={() => update(d => ({ ...d, plans: d.plans.map(p => p.name !== planEdit ? p : { ...p, items: p.items.filter(x => x.id !== item.id) }) }))}>×</button>
          </div>)}
        </div>
        <div className="panel add-exercise">
          <h3>Übung hinzufügen</h3><p className="muted small">Aus deiner Übungsbibliothek auswählen</p>
          <div className="library-list">{allExerciseOptions.map(e => <button key={e.id} onClick={() => addPlanExercise(e)}>{e.name}<span>＋</span></button>)}</div>
          <div className="custom-exercise"><input value={newExercise} onChange={e => setNewExercise(e.target.value)} placeholder="Eigene Übung erstellen…" onKeyDown={e => e.key === "Enter" && createExercise()} /><button className="primary-small" onClick={createExercise}>Hinzufügen</button></div>
        </div>
        <div className="panel setting-inline"><div><b>Satzanzahl dauerhaft übernehmen</b><p className="muted small">Änderungen der Satzanzahl im Training in den Plan schreiben.</p></div>
          <button className={`toggle ${data.persistSetChanges ? "on" : ""}`} role="switch" aria-checked={data.persistSetChanges} onClick={() => update(d => ({ ...d, persistSetChanges: !d.persistSetChanges }))}><span /></button></div>
      </section>}

      {tab === "Statistik" && <section>
        <div className="eyebrow">DATEN STATT BAUCHGEFÜHL</div><h1>Dein <span>Fortschritt.</span></h1>
        <p className="muted intro">Alle Auswertungen basieren ausschließlich auf deinen gespeicherten Einheiten.</p>
        <div className="stats-grid">
          <div className="stat-card"><span>TRAINING GESAMT</span><strong>{data.history.length}</strong><small>Einheiten</small></div>
          <div className="stat-card"><span>DIESE WOCHE</span><strong>{countPeriod(data.history, "week")}</strong><small>Einheiten</small></div>
          <div className="stat-card"><span>DIESEN MONAT</span><strong>{countPeriod(data.history, "month")}</strong><small>Einheiten</small></div>
        </div>
        <div className="panel chart-panel"><div className="section-heading"><h3>Kraftentwicklung</h3></div>
          <select value={selectedStatsExercise} onChange={e => setSelectedStatsExercise(e.target.value)}><option value="">Übung auswählen</option>{data.exercises.map(e => <option value={e.id} key={e.id}>{e.name}</option>)}</select>
          {selectedStatsExercise ? <ProgressChart sessions={data.history} exerciseId={selectedStatsExercise} /> : <div className="empty compact">Wähle eine Übung, um Gewicht und Wiederholungen zu sehen.</div>}
        </div>
        <div className="panel"><h3>Persönliche Bestleistungen</h3>
          {personalRecords(data).length === 0 ? <p className="muted small">Noch keine abgeschlossenen Sätze vorhanden.</p> : personalRecords(data).slice(0, 8).map(r => <div className="record-row" key={r.id}><span>{r.name}</span><b>{r.weight} kg <small>× {r.reps}</small></b></div>)}
        </div>
      </section>}

      {tab === "Verlauf" && <section>
        <div className="eyebrow">DEINE TRAININGSTAGE</div><h1>Trainings<span>verlauf.</span></h1>
        {active && <div className="resume-card"><div><span className="eyebrow">TRAINING OFFEN</span><b>{active.type} · {dateLabel(active.startedAt)}</b><small>Dein Zwischenstand ist lokal gespeichert.</small></div><button className="primary-small" onClick={() => setTab("Training")}>Fortsetzen</button></div>}
        {selectedSession ? <div className="panel session-detail">
          <button className="back-link" onClick={() => setSelectedHistory(null)}>← Zurück zum Verlauf</button>
          <h2>{selectedSession.type}</h2><p className="muted">{dateLabel(selectedSession.startedAt)}{selectedSession.durationSeconds !== undefined ? ` · ${Math.floor(selectedSession.durationSeconds / 60)} Min.` : ""}</p>
          <span className={`status-pill ${selectedSession.completed ? "complete" : ""}`}>{selectedSession.completed ? "Vollständig" : "Unvollständig gespeichert"}</span>
          {selectedSession.exercises.map(e => <div className="detail-exercise" key={e.id}><b>{e.name}</b>{e.sets.map((s, i) => <p key={s.id}>Satz {i + 1}: {s.weight || "–"} kg × {s.reps || "–"} Wdh. {s.done ? "✓" : "· nicht erledigt"}</p>)}</div>)}
          <button className="danger-outline" onClick={() => { if (window.confirm("Diese Trainingseinheit wirklich löschen?")) { update(d => ({ ...d, history: d.history.filter(s => s.id !== selectedSession.id) })); setSelectedHistory(null); } }}>Einheit löschen</button>
        </div> : data.history.length === 0 ? <div className="empty">Hier erscheinen deine gespeicherten Trainings. Los geht's!</div> :
          <div className="history-list">{data.history.map(s => <button className="history-card" key={s.id} onClick={() => setSelectedHistory(s.id)}>
            <div className="history-badge">{s.type.slice(0,1)}</div><div className="grow"><b>{s.type}</b><small>{dateLabel(s.startedAt)}</small><small>{s.exercises.length} Übungen · {s.exercises.reduce((n, e) => n + e.sets.filter(x => x.done).length, 0)} Sätze erledigt</small></div>
            <span className={`status-dot ${s.completed ? "done" : ""}`} /> <span className="muted">›</span>
          </button>)}</div>}
        <div className="panel settings-panel"><h3>Datensicherung & Einstellungen</h3>
          <p className="muted small">Deine Trainingsdaten werden weiterhin lokal gespeichert. Zusätzlich kannst du ein persönliches Cloud-Backup mit deinem Google-Konto aktivieren.</p>
          <div className="cloud-panel">
            <div className="cloud-heading"><b>☁ Cloud-Backup</b><span className="muted small">{user ? user.email : "Nicht angemeldet"}</span></div>
            {!user ? <button className="secondary-btn full" onClick={connectGoogle} disabled={cloudBusy}>{cloudBusy ? "Wird geöffnet…" : "Mit Google verbinden"}</button> : <>
              <p className="muted small">Status: {cloudStatus}</p>
              {cloudChoice === "choose" && pendingCloud && <>
                <p className="small">Es wurde bereits ein Cloud-Backup gefunden. Wähle bewusst, welche Daten verwendet werden sollen.</p>
                <button className="primary-small full" onClick={restoreCloudBackup} disabled={cloudBusy}>Cloud-Backup auf diesem Gerät wiederherstellen</button>
                <button className="secondary-btn full" onClick={useLocalAndReplaceCloud} disabled={cloudBusy}>Lokale Daten verwenden und Cloud ersetzen</button>
              </>}
              {cloudChoice === "blocked" && <p className="small warning-text">Das vorhandene Cloud-Backup hat ein unbekanntes Format. Es wird nicht überschrieben. Bitte melde dich beim Support, bevor du fortfährst.</p>}
              {cloudChoice === "choose" && !pendingCloud && <button className="primary-small full" onClick={chooseLocalForCloud} disabled={cloudBusy}>{cloudBusy ? "Wird gesichert…" : "Lokale Daten erstmals in der Cloud sichern"}</button>}
              {cloudChoice === "enabled" && <p className="small cloud-ok">Automatische Sicherung ist aktiviert. Änderungen werden nach kurzer Pause hochgeladen.</p>}
              <button className="text-btn" onClick={() => signOut(auth).catch(console.error)}>Google-Konto trennen</button>
            </>}
          </div>
          <button className="secondary-btn full" onClick={exportData}>↓ Daten als JSON exportieren</button>
          <button className="secondary-btn full" onClick={() => importRef.current?.click()}>↑ JSON-Backup importieren</button>
          <input ref={importRef} type="file" accept="application/json,.json" hidden onChange={e => importData(e.target.files?.[0])} />
          <p className="warning-text">Achtung: Durch das Löschen von Website-Daten, das Entfernen der Website oder bestimmte Browseraktionen können lokale Trainingsdaten verloren gehen.</p>
          <button className="danger-outline full" onClick={deleteAll}>Alle Daten vollständig löschen</button>
        </div>
      </section>}
    </main>

    <nav className="bottom-nav">
      {(["Training", "Pläne", "Statistik", "Verlauf"] as const).map((item, i) => <button key={item} className={tab === item ? "active" : ""} onClick={() => setTab(item)}>
        <span className="nav-icon">{["◉", "▤", "▥", "◷"][i]}</span><span>{item}</span>
      </button>)}
    </nav>
  </div>;
}

function countPeriod(history: Session[], period: "week" | "month") {
  const now = new Date();
  return history.filter(s => {
    const d = new Date(s.startedAt);
    if (period === "month") return d.getFullYear() === now.getFullYear() && d.getMonth() === now.getMonth();
    const start = new Date(now); start.setHours(0, 0, 0, 0); start.setDate(start.getDate() - ((start.getDay() + 6) % 7));
    return d >= start;
  }).length;
}
function personalRecords(data: AppData) {
  const records: { id: string; name: string; weight: number; reps: number }[] = [];
  for (const exercise of data.exercises) {
    let best = 0, bestReps = 0;
    data.history.forEach(s => s.exercises.filter(e => e.exerciseId === exercise.id).forEach(e => e.sets.filter(x => x.done && x.weight !== "" && x.reps !== "").forEach(x => {
      const w = Number(x.weight), reps = Number(x.reps);
      if (w > best || (w === best && reps > bestReps)) { best = w; bestReps = reps; }
    })));
    if (best > 0) records.push({ id: exercise.id, name: exercise.name, weight: best, reps: bestReps });
  }
  return records.sort((a, b) => b.weight - a.weight);
}
function ProgressChart({ sessions, exerciseId }: { sessions: Session[]; exerciseId: string }) {
  const rows = sessions.slice().reverse().flatMap(s => s.exercises.filter(e => e.exerciseId === exerciseId).flatMap(e =>
    e.sets.filter(st => st.done && st.weight !== "" && st.reps !== "").map(st => ({ date: new Date(s.startedAt), weight: Number(st.weight), reps: Number(st.reps) }))
  ));
  if (!rows.length) return <div className="empty compact">Für diese Übung gibt es noch keine abgeschlossenen Sätze mit Werten.</div>;
  const max = Math.max(...rows.map(r => r.weight), 1), min = Math.min(...rows.map(r => r.weight), 0);
  const span = Math.max(max - min, 1);
  const points = rows.slice(-12);
  const width = 320, height = 140, pad = 12;
  const coords = points.map((p, i) => ({ x: pad + (points.length === 1 ? 0 : i * (width - 2 * pad) / (points.length - 1)), y: height - pad - ((p.weight - min) / span) * (height - 2 * pad) }));
  const path = coords.map((p, i) => `${i ? "L" : "M"} ${p.x} ${p.y}`).join(" ");
  return <div className="chart-wrap"><div className="chart-legend"><span><i /> Gewicht (kg)</span><b>{Math.max(...rows.map(r => r.weight))} kg max.</b></div>
    <svg viewBox={`0 0 ${width} ${height}`} role="img" aria-label="Gewichtsverlauf"><path d={`M ${pad} ${height-pad} H ${width-pad}`} stroke="#303a32" strokeWidth="1" fill="none"/><path d={path} stroke="#7ee787" strokeWidth="3" fill="none" strokeLinecap="round" strokeLinejoin="round"/>{coords.map((p, i) => <circle key={i} cx={p.x} cy={p.y} r="4" fill="#7ee787" />)}</svg>
    <div className="chart-dates"><span>{points[0].date.toLocaleDateString("de-DE")}</span><span>{points[points.length - 1].date.toLocaleDateString("de-DE")}</span></div>
    <div className="chart-legend reps-legend"><span><i /> Wiederholungen</span><b>{Math.max(...rows.map(r => r.reps))} Wdh. max.</b></div>
    <svg viewBox={`0 0 ${width} ${height}`} role="img" aria-label="Wiederholungsverlauf"><path d={`M ${pad} ${height-pad} H ${width-pad}`} stroke="#303a32" strokeWidth="1" fill="none"/><path d={points.map((p, i) => `${i ? "L" : "M"} ${pad + (points.length === 1 ? 0 : i * (width - 2 * pad) / (points.length - 1))} ${height - pad - (p.reps / Math.max(...points.map(x => x.reps), 1)) * (height - 2 * pad)}`).join(" ")} stroke="#7ee787" strokeWidth="3" fill="none" strokeLinecap="round" strokeLinejoin="round"/>{points.map((p, i) => <circle key={i} cx={pad + (points.length === 1 ? 0 : i * (width - 2 * pad) / (points.length - 1))} cy={height - pad - (p.reps / Math.max(...points.map(x => x.reps), 1)) * (height - 2 * pad)} r="4" fill="#7ee787" />)}</svg>
    <div className="chart-dates"><span>{points[0].date.toLocaleDateString("de-DE")}</span><span>{points[points.length - 1].date.toLocaleDateString("de-DE")}</span></div>
  </div>;
}