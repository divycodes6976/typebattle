"use client";
import { useEffect, useMemo, useRef, useState, type MutableRefObject } from "react";
import { getApiBaseUrl } from "../lib/apiBase";
import PlayTypingBox from "./PlayTypingBox";

type Difficulty = "easy" | "medium" | "hard";

/** Matches backend bank size per difficulty (3 entries each). */
const PARAGRAPH_BANK_SIZE = 3;
const LOCAL_PARAGRAPH_CACHE_KEY = "typebattle_paragraph_cache_v1";

function splitWords(text: string) {
  return text.trim().split(/\s+/g).filter(Boolean);
}

async function fetchRandomParagraphFromApi(difficulty: Difficulty): Promise<string> {
  const base = getApiBaseUrl();
  const url = new URL(`${base}/api/paragraph`);
  url.searchParams.set("difficulty", difficulty);
  const res = await fetch(url.toString());
  if (!res.ok) throw new Error(`Paragraph request failed (${res.status})`);
  const data = (await res.json()) as { paragraph?: unknown };
  const paragraph = typeof data.paragraph === "string" ? data.paragraph.trim() : "";
  if (!paragraph) throw new Error("Empty paragraph from server");
  return paragraph;
}

function readParagraphCache(): Partial<Record<Difficulty, string>> {
  if (typeof window === "undefined") return {};
  try {
    const raw = window.localStorage.getItem(LOCAL_PARAGRAPH_CACHE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as Partial<Record<Difficulty, string>>;
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

function writeParagraphCache(difficulty: Difficulty, paragraph: string) {
  if (typeof window === "undefined") return;
  try {
    const next = { ...readParagraphCache(), [difficulty]: paragraph };
    window.localStorage.setItem(LOCAL_PARAGRAPH_CACHE_KEY, JSON.stringify(next));
  } catch {
    // Ignore localStorage issues quietly.
  }
}

async function getNextParagraphForSession(
  difficulty: Difficulty,
  usedRef: MutableRefObject<Set<string>>
): Promise<string> {
  if (usedRef.current.size >= PARAGRAPH_BANK_SIZE) {
    usedRef.current.clear();
  }
  let newPara: string;
  let guard = 0;
  do {
    newPara = await fetchRandomParagraphFromApi(difficulty);
    guard += 1;
    if (guard > 100) {
      usedRef.current.clear();
      newPara = await fetchRandomParagraphFromApi(difficulty);
      break;
    }
  } while (usedRef.current.has(newPara));
  usedRef.current.add(newPara);
  return newPara;
}

function getWordStats(expectedWord: string, typedWord: string) {
  const expectedChars = Array.from(expectedWord ?? "");
  const typedChars = Array.from(typedWord ?? "");
  const len = Math.min(expectedChars.length, typedChars.length);
  let correctChars = 0;
  for (let i = 0; i < len; i += 1) {
    if (typedChars[i]?.toLowerCase() === expectedChars[i]?.toLowerCase()) correctChars += 1;
  }
  return {
    typedChars: typedChars.length,
    correctChars,
  };
}

export type TypingStats = {
  wpm: number;
  accuracy: number;
  mistakes: number;
};

export type TypingSessionResult = TypingStats & {
  totalTyped: number;
  correct: number;
  timeSeconds: number;
  consistency: number;
};

type TypingBoxProps = {
  difficulty?: Difficulty;
  timeLimitSeconds?: number;
  onStatsChange?: (stats: TypingStats) => void;
  onComplete?: (result: TypingSessionResult) => void;
};

function ClockIcon({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      aria-hidden="true"
    >
      <circle cx="12" cy="12" r="9" />
      <path d="M12 7v6l4 2" />
    </svg>
  );
}

export default function TypingBox({
  difficulty = "medium",
  timeLimitSeconds = 60,
  onStatsChange,
  onComplete,
}: TypingBoxProps) {
  const paragraphRef = useRef("");
  const [paragraph, setParagraph] = useState("");
  const [words, setWords] = useState<string[]>([]);
  const [currentWordIndex, setCurrentWordIndex] = useState(0);
  const [typedWord, setTypedWord] = useState("");
  const [typedWords, setTypedWords] = useState<string[]>([]);
  const currentWordIndexRef = useRef(0);
  const typedWordRef = useRef("");
  const [secondsLeft, setSecondsLeft] = useState(timeLimitSeconds);
  const [isDone, setIsDone] = useState(false);
  const [hasStarted, setHasStarted] = useState(false);
  const [transitionPhase, setTransitionPhase] = useState<"in" | "out">("in");
  const [isTransitioning, setIsTransitioning] = useState(false);
  const [startTimeMs, setStartTimeMs] = useState<number | null>(null);
  const [totalTypedChars, setTotalTypedChars] = useState(0);
  const [totalCorrectChars, setTotalCorrectChars] = useState(0);
  const wpmSamplesRef = useRef<number[]>([]);
  const didCompleteRef = useRef(false);
  const usedParagraphs = useRef(new Set<string>());
  const prefetchedParagraphRef = useRef<string | null>(null);
  const [paragraphError, setParagraphError] = useState<string | null>(null);
  const [isLoadingParagraph, setIsLoadingParagraph] = useState(true);

  useEffect(() => {
    paragraphRef.current = paragraph;
  }, [paragraph]);

  useEffect(() => {
    let cancelled = false;
    usedParagraphs.current.clear();
    prefetchedParagraphRef.current = null;
    setParagraphError(null);
    const cached = readParagraphCache()[difficulty];
    if (typeof cached === "string" && cached.trim()) {
      const instant = cached.trim();
      setParagraph(instant);
      usedParagraphs.current.add(instant);
      setIsLoadingParagraph(false);
    } else {
      setIsLoadingParagraph(true);
      setParagraph("");
    }
    void (async () => {
      try {
        const text = await getNextParagraphForSession(difficulty, usedParagraphs);
        if (cancelled) return;
        writeParagraphCache(difficulty, text);
        if (!cached) {
          setParagraph(text);
          setIsLoadingParagraph(false);
        } else {
          prefetchedParagraphRef.current = text;
        }
      } catch (e) {
        if (!cancelled) {
          setParagraphError(e instanceof Error ? e.message : "Could not load paragraph");
          setIsLoadingParagraph(false);
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [difficulty]);

  useEffect(() => {
    if (!paragraph) return;
    const nextWords = splitWords(paragraph);
    setWords(nextWords);
    setCurrentWordIndex(0);
    setTypedWord("");
    setTypedWords([]);
  }, [paragraph]);

  const currentWordLiveStats = useMemo(() => {
    return getWordStats(words[currentWordIndex] ?? "", typedWord);
  }, [words, currentWordIndex, typedWord]);

  const liveTotalTypedChars = totalTypedChars + typedWord.length;
  const liveTotalCorrectChars = totalCorrectChars + currentWordLiveStats.correctChars;
  const mistakes = Math.max(0, liveTotalTypedChars - liveTotalCorrectChars);
  const elapsedSeconds = Math.max(
    1,
    startTimeMs == null ? 1 : Math.floor((Date.now() - startTimeMs) / 1000)
  );
  const wpm =
    liveTotalTypedChars > 0 ? Math.round((liveTotalCorrectChars / 5) * (60 / elapsedSeconds)) : 0;
  const accuracy =
    liveTotalTypedChars > 0
      ? Math.max(0, Math.round((liveTotalCorrectChars / liveTotalTypedChars) * 100))
      : 100;

  useEffect(() => {
    currentWordIndexRef.current = currentWordIndex;
  }, [currentWordIndex]);

  useEffect(() => {
    typedWordRef.current = typedWord;
  }, [typedWord]);

  useEffect(() => {
    if (!hasStarted || isDone) return;

    const id = window.setInterval(() => {
      setSecondsLeft((s) => {
        if (s <= 1) {
          setIsDone(true);
          return 0;
        }
        return s - 1;
      });
    }, 1000);

    return () => window.clearInterval(id);
  }, [hasStarted, isDone]);

  const progressPercent = Math.min(
    100,
    Math.max(0, Math.round(((timeLimitSeconds - secondsLeft) / timeLimitSeconds) * 100))
  );

  useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      if (!hasStarted && event.key.length === 1) {
        setHasStarted(true);
        if (startTimeMs == null) setStartTimeMs(Date.now());
      }
      if (isDone || isTransitioning || words.length === 0) return;
      const key = event.key;

      const commitCurrentWord = (committedWord: string) => {
        const activeWordIndex = currentWordIndexRef.current;
        const expected = words[activeWordIndex] ?? "";
        if (!expected) return;
        if (committedWord.length < expected.length) return;
        const committedStats = getWordStats(expected, committedWord);
        setTypedWords((prev) => {
          const next = [...prev];
          next[activeWordIndex] = committedWord;
          return next;
        });
        setTotalTypedChars((prev) => prev + committedStats.typedChars);
        setTotalCorrectChars((prev) => prev + committedStats.correctChars);

        const isLastWord = activeWordIndex === words.length - 1;
        if (isLastWord && secondsLeft > 0) {
          setTransitionPhase("out");
          setIsTransitioning(true);

          void (async () => {
            try {
              let newPara = prefetchedParagraphRef.current;
              if (!newPara) {
                newPara = await getNextParagraphForSession(difficulty, usedParagraphs);
              } else {
                prefetchedParagraphRef.current = null;
                usedParagraphs.current.add(newPara);
              }
              writeParagraphCache(difficulty, newPara);
              paragraphRef.current = newPara;
              const nextWords = splitWords(newPara);
              setParagraph(newPara);
              setWords(nextWords);
              currentWordIndexRef.current = 0;
              typedWordRef.current = "";
              setCurrentWordIndex(0);
              setTypedWord("");
              setTypedWords([]);
              setParagraphError(null);
              void (async () => {
                try {
                  const upcoming = await getNextParagraphForSession(difficulty, usedParagraphs);
                  prefetchedParagraphRef.current = upcoming;
                  writeParagraphCache(difficulty, upcoming);
                } catch {
                  prefetchedParagraphRef.current = null;
                }
              })();
            } catch (e) {
              setParagraphError(e instanceof Error ? e.message : "Failed to load next paragraph");
            } finally {
              window.setTimeout(() => {
                setTransitionPhase("in");
                setIsTransitioning(false);
              }, 90);
            }
          })();
          return;
        }
        setCurrentWordIndex((prev) => {
          const next = prev + 1 < words.length ? prev + 1 : prev;
          currentWordIndexRef.current = next;
          return next;
        });
        typedWordRef.current = "";
        setTypedWord("");
      };

      if (key === "Backspace") {
        event.preventDefault();
        setTypedWord((prev) => {
          if (prev.length > 0) return prev.slice(0, -1);
          if (currentWordIndexRef.current === 0) return prev;

          const previousIndex = currentWordIndexRef.current - 1;
          const previousTyped = typedWords[previousIndex] ?? "";
          const previousExpected = words[previousIndex] ?? "";
          const previousStats = getWordStats(previousExpected, previousTyped);

          currentWordIndexRef.current = previousIndex;
          typedWordRef.current = previousTyped;
          setCurrentWordIndex(previousIndex);
          setTypedWords((current) => {
            const next = [...current];
            next[previousIndex] = "";
            return next;
          });
          setTotalTypedChars((value) => Math.max(0, value - previousStats.typedChars));
          setTotalCorrectChars((value) => Math.max(0, value - previousStats.correctChars));
          return previousTyped;
        });
        return;
      }

      if (key === " " || key === "Spacebar" || key === "Space" || event.code === "Space") {
        const liveTypedWord = typedWordRef.current;
        if (!liveTypedWord) return;
        event.preventDefault();
        commitCurrentWord(liveTypedWord);
        return;
      }

      if (
        key === "Enter" ||
        key === "Shift" ||
        key === "Control" ||
        key === "Alt" ||
        key === "Meta" ||
        key === "Tab"
      ) {
        return;
      }

      if (key.length === 1) {
        event.preventDefault();
        const nextTyped = `${typedWordRef.current}${key.toLowerCase()}`;
        typedWordRef.current = nextTyped;
        const activeWordIndex = currentWordIndexRef.current;
        const expected = words[activeWordIndex] ?? "";
        const isLastWord = activeWordIndex >= words.length - 1;
        if (isLastWord && expected && nextTyped.length >= expected.length) {
          commitCurrentWord(nextTyped);
          return;
        }
        setTypedWord(nextTyped);
      }
    };

    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [
    isDone,
    words,
    currentWordIndex,
    typedWord,
    typedWords,
    hasStarted,
    isTransitioning,
    secondsLeft,
    startTimeMs,
    difficulty,
  ]);

  useEffect(() => {
    if (!isDone) {
      wpmSamplesRef.current.push(wpm);
    }
  }, [wpm, isDone]);

  useEffect(() => {
    onStatsChange?.({
      wpm,
      accuracy,
      mistakes,
    });
  }, [onStatsChange, wpm, accuracy, mistakes]);

  useEffect(() => {
    if (!isDone || didCompleteRef.current) return;

    didCompleteRef.current = true;
    const samples = wpmSamplesRef.current.filter((v) => v >= 0);
    const avg = samples.length
      ? samples.reduce((sum, value) => sum + value, 0) / samples.length
      : 0;
    const variance = samples.length
      ? samples.reduce((sum, value) => sum + (value - avg) ** 2, 0) / samples.length
      : 0;
    const stdDev = Math.sqrt(variance);
    const consistency =
      avg > 0 ? Math.max(0, Math.min(100, Math.round(100 - (stdDev / avg) * 100))) : 0;

    onComplete?.({
      wpm,
      accuracy,
      mistakes,
      totalTyped: liveTotalTypedChars,
      correct: liveTotalCorrectChars,
      timeSeconds: timeLimitSeconds,
      consistency,
    });
  }, [onComplete, isDone, wpm, accuracy, mistakes, liveTotalTypedChars, liveTotalCorrectChars, timeLimitSeconds]);

  return (
    <div className="w-full max-w-[980px] rounded-lg border border-[#1f2633] bg-[#0b0f14] px-6 py-5">
      <div className="flex items-start justify-between gap-6">
        <div className="flex items-center gap-3">
          <ClockIcon className="h-6 w-6 text-[#fbbf24]" />
          <div className="leading-none">
            <div className="text-[12px] font-semibold tracking-wide text-[#8b96a8]">
              TIME LEFT
            </div>
            <div className="mt-2 text-[28px] font-bold text-[#fbbf24]">
              {secondsLeft}s
            </div>
          </div>
        </div>

        <div className="text-right">
          <div className="text-[12px] font-semibold tracking-wide text-[#8b96a8]">
            PROGRESS
          </div>
          <div className="mt-2 text-[22px] font-semibold text-[#e5e7eb]">
            {progressPercent}%
          </div>
        </div>
      </div>

      <div className="mt-4 text-center font-mono text-[14px] text-[#7b8596]">
        {paragraphError ? (
          <span className="text-red-400">{paragraphError}</span>
        ) : isLoadingParagraph ? (
          "Loading paragraph…"
        ) : hasStarted ? (
          "Keep going..."
        ) : (
          "Start typing to begin..."
        )}
      </div>

      <div className="mt-5 flex items-center justify-center">
        <PlayTypingBox
          words={words}
          currentWordIndex={currentWordIndex}
          typedWord={typedWord}
          typedWords={typedWords}
          secondsLeft={secondsLeft}
          transitionPhase={transitionPhase}
        />
      </div>
    </div>
  );
}
