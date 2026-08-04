/**
 * useDraftRecovery — auto-saves an edit form to sessionStorage every ~3s and
 * offers to restore it next time the same product is opened for edit. Prevents
 * lost work from accidental modal closes, browser refreshes, or fork sessions.
 *
 * scope: string  — a namespace for this Manager (e.g. 'manager-edit:flooring')
 * key:   string  — the product SKU/supplier_code (draft is stored per-product)
 * form:  object  — the current form state
 * setForm: fn    — setter to restore a draft
 * active: bool   — whether the edit modal is currently open (paused when false)
 *
 * Returns { status, showRestore, restore, dismiss, clearDraft, draftTimeLabel }
 */

import { useEffect, useRef, useState, useCallback } from 'react';

const AUTOSAVE_INTERVAL_MS = 3000;
const STORAGE_PREFIX = 'tilestation-draft:';

const storageKey = (scope, key) => `${STORAGE_PREFIX}${scope}:${key}`;

const readDraft = (scope, key) => {
  try {
    const raw = sessionStorage.getItem(storageKey(scope, key));
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
};

const writeDraft = (scope, key, form) => {
  try {
    sessionStorage.setItem(storageKey(scope, key), JSON.stringify({ form, savedAt: Date.now() }));
    return true;
  } catch {
    return false;
  }
};

const clearDraftStorage = (scope, key) => {
  try { sessionStorage.removeItem(storageKey(scope, key)); } catch { /* ignore */ }
};

const timeAgoLabel = (ts) => {
  if (!ts) return 'just now';
  const sec = Math.round((Date.now() - ts) / 1000);
  if (sec < 60) return `${sec}s ago`;
  const min = Math.round(sec / 60);
  if (min < 60) return `${min} min ago`;
  const hr = Math.round(min / 60);
  if (hr < 24) return `${hr} hr ago`;
  const day = Math.round(hr / 24);
  return `${day} day${day === 1 ? '' : 's'} ago`;
};

export const useDraftRecovery = ({ scope, key, form, setForm, active }) => {
  const [status, setStatus] = useState('idle');   // 'idle' | 'saving' | 'saved'
  const [showRestore, setShowRestore] = useState(false);
  const [draftSavedAt, setDraftSavedAt] = useState(null);
  const [dismissed, setDismissed] = useState(false);
  const seenKeyRef = useRef(null);

  // On mount / key change, check for an existing draft
  useEffect(() => {
    if (!active || !key || seenKeyRef.current === key) return;
    seenKeyRef.current = key;
    const draft = readDraft(scope, key);
    if (draft && draft.savedAt && Date.now() - draft.savedAt < 7 * 24 * 60 * 60 * 1000) {
      setDraftSavedAt(draft.savedAt);
      setShowRestore(true);
      setDismissed(false);
    } else {
      setShowRestore(false);
      setDraftSavedAt(null);
    }
  }, [active, key, scope]);

  // Reset when modal closes
  useEffect(() => {
    if (!active) {
      seenKeyRef.current = null;
      setStatus('idle');
      setShowRestore(false);
      setDraftSavedAt(null);
      setDismissed(false);
    }
  }, [active]);

  // Auto-save every 3s if form has been touched (skipped if the restore banner is
  // still visible — we don't want to overwrite the draft while the user decides).
  useEffect(() => {
    if (!active || !key || dismissed === false && showRestore) return; // wait for user decision
    if (!form || Object.keys(form).length === 0) return;
    const id = setInterval(() => {
      setStatus('saving');
      const ok = writeDraft(scope, key, form);
      setStatus(ok ? 'saved' : 'idle');
    }, AUTOSAVE_INTERVAL_MS);
    return () => clearInterval(id);
  }, [active, key, scope, form, showRestore, dismissed]);

  const restore = useCallback(() => {
    const draft = readDraft(scope, key);
    if (draft && draft.form) {
      setForm(draft.form);
      setShowRestore(false);
      setStatus('saved');
    }
  }, [scope, key, setForm]);

  const dismiss = useCallback(() => {
    setShowRestore(false);
    setDismissed(true);
  }, []);

  const clearDraft = useCallback(() => {
    if (key) clearDraftStorage(scope, key);
    setShowRestore(false);
    setStatus('idle');
  }, [scope, key]);

  return {
    status,
    showRestore,
    restore,
    dismiss,
    clearDraft,
    draftTimeLabel: draftSavedAt ? timeAgoLabel(draftSavedAt) : 'earlier',
  };
};

export default useDraftRecovery;
