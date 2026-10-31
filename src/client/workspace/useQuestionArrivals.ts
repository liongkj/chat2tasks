import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { Chat, Snapshot } from '../../shared/schema.js';
import { playSound } from '../../shared/sound.js';
import type { WorkspaceLocation } from '../taskLocation.js';

/**
 * Which clarification questions arrived since the last snapshot. New ones get
 * a short highlight and one attention sound, but only in views that show
 * them and only while the window is in front.
 */
export function useQuestionArrivals(
  data: Snapshot,
  loaded: boolean,
  location: WorkspaceLocation,
  chat: Chat | undefined,
) {
  const [newQuestions, setNewQuestions] = useState<Set<string>>(new Set());
  const seenQuestions = useRef<Set<string> | null>(null);
  useEffect(() => {
    if (!newQuestions.size) return;
    const timer = setTimeout(() => setNewQuestions(new Set()), 200);
    return () => clearTimeout(timer);
  }, [newQuestions]);
  useLayoutEffect(() => {
    if (!loaded) return;
    if (!seenQuestions.current) {
      seenQuestions.current = new Set(data.questions.map((question) => question.id));
      return;
    }
    const arrived = data.questions.filter((question) => !seenQuestions.current?.has(question.id));
    for (const question of arrived) seenQuestions.current.add(question.id);
    if (!['tasks', 'review', 'conversations'].includes(location.view)) return;
    const visible = arrived.filter((question) => {
      if (location.view !== 'conversations') return true;
      const message = data.messages.find((item) => item.id === question.message_id);
      return chat && message?.chatId === chat.chatId && message.sessionId === chat.sessionId;
    });
    if (!visible.length || document.visibilityState !== 'visible' || !document.hasFocus()) return;
    setNewQuestions(new Set(visible.map((question) => question.id)));
    void playSound('attention', data.sound);
  }, [loaded, data.questions, data.messages, data.sound, location.view, chat]);
  return newQuestions;
}
