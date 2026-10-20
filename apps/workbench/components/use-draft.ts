'use client';

import { useEffect, useRef, useState, type RefObject } from 'react';
import { MAX_ATTACHMENTS, MAX_TASK_INPUTS, type DraftReference } from '../lib/api';
import type { Mode } from './composer';

/**
 * What the next message will send: its text, Task/Chat mode, task input bindings and attachments.
 * A file chosen in Input files is attached (images, PDFs) or bound as a task input; nothing is sent.
 * Refs mirror the values so a memoized chat transport always reads the current ones.
 */
export function useDraft(draftReference: DraftReference | undefined, textarea: RefObject<HTMLTextAreaElement | null>) {
  const [input, setInput] = useState('');
  const [mode, setMode] = useState<Mode>('task');
  const [boundInputs, setBoundInputs] = useState<string[]>([]);
  const [bindingError, setBindingError] = useState('');
  const [attachments, setAttachments] = useState<string[]>([]);
  const modeRef = useRef(mode);
  modeRef.current = mode;
  const boundInputsRef = useRef(boundInputs);
  boundInputsRef.current = boundInputs;
  /** Set only for the duration of one send, so the transport sends what the composer showed. */
  const sendingAttachments = useRef<string[]>([]);
  const insertedReference = useRef<string | undefined>(undefined);

  // An imported file was chosen: attach it, or insert its path and bind it as a task input. Never auto-send.
  useEffect(() => {
    if (!draftReference || draftReference.id === insertedReference.current) return;
    insertedReference.current = draftReference.id;
    // Images and PDFs are shown to the model with the next message instead of being bound as task inputs.
    if (draftReference.attach) {
      // The effect runs once per reference, so reading this render's attachments is current.
      if (attachments.length >= MAX_ATTACHMENTS && !attachments.includes(draftReference.path)) {
        setBindingError(`A message can carry up to ${MAX_ATTACHMENTS} attachments.`);
        return;
      }
      setBindingError('');
      setAttachments(previous => previous.includes(draftReference.path) ? previous : [...previous, draftReference.path]);
      textarea.current?.focus();
      return;
    }
    setMode('task');
    if (boundInputsRef.current.length >= MAX_TASK_INPUTS && !boundInputsRef.current.includes(draftReference.path)) {
      setBindingError(`A task can bind up to ${MAX_TASK_INPUTS} input declarations. Remove one before using another uploaded file.`);
      return;
    }
    setBindingError('');
    setInput(previous => previous ? `${previous}\n${draftReference.text}` : draftReference.text);
    setBoundInputs(previous => previous.includes(draftReference.path) ? previous : [...previous, draftReference.path]);
    textarea.current?.focus();
  }, [draftReference]);

  /** Send with the attachments the composer shows; the composer clears them at once. */
  async function sendWith(send: () => Promise<void>) {
    sendingAttachments.current = attachments;
    setAttachments([]);
    try {
      await send();
    } finally {
      sendingAttachments.current = [];
    }
  }

  return {
    input, setInput, mode, setMode, boundInputs, setBoundInputs, bindingError, setBindingError,
    attachments, setAttachments, modeRef, boundInputsRef, sendingAttachments, sendWith,
  };
}
