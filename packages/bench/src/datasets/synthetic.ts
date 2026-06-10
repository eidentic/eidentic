/**
 * Bundled synthetic benchmark dataset for CI (§6.10).
 *
 * Covers all four categories: single-session, multi-session, temporal, knowledge-update.
 * Deterministic, hand-written, no real models or large files needed.
 *
 * Design notes for FakeEmbedder compatibility:
 *   FakeEmbedder hashes word tokens into a fixed-dim bag-of-words vector. Recall is highest
 *   when the gold fact shares tokens with the question OR the ingested turn. Gold facts are
 *   therefore written as verbatim substrings of ingested turns so that lexical recall works,
 *   and questions use overlapping vocabulary so semantic (vector) recall also fires.
 */
import type { BenchDataset } from "../types.js";

export const syntheticDataset: BenchDataset = {
  name: "eidentic-synthetic-v1",
  cases: [
    // ── Case 1: single-session ──────────────────────────────────────────────────────────────────
    {
      id: "single-session-basics",
      turns: [
        {
          role: "user",
          text: "My name is Alice and I live in London. I am a software engineer.",
          sessionId: "s1",
        },
        {
          role: "assistant",
          text: "Nice to meet you Alice! London is a great city for tech.",
          sessionId: "s1",
        },
        {
          role: "user",
          text: "I prefer TypeScript over Python for backend work.",
          sessionId: "s1",
        },
        {
          role: "assistant",
          text: "TypeScript is indeed excellent for backend development.",
          sessionId: "s1",
        },
      ],
      questions: [
        {
          question: "Where does Alice live?",
          goldFacts: ["Alice", "London"],
          answer: "London",
          category: "single-session",
        },
        {
          question: "What programming language does the user prefer for backend work?",
          goldFacts: ["TypeScript", "backend"],
          answer: "TypeScript",
          category: "single-session",
        },
      ],
    },

    // ── Case 2: multi-session ───────────────────────────────────────────────────────────────────
    {
      id: "multi-session-cross",
      turns: [
        // Session A: user shares hobby
        {
          role: "user",
          text: "I enjoy playing chess on weekends.",
          sessionId: "session-a",
          ts: "2026-01-01T10:00:00Z",
        },
        {
          role: "assistant",
          text: "Chess is a great mental exercise!",
          sessionId: "session-a",
          ts: "2026-01-01T10:00:01Z",
        },
        // Session B: user shares work preference
        {
          role: "user",
          text: "At work I use React for frontend development.",
          sessionId: "session-b",
          ts: "2026-01-15T09:00:00Z",
        },
        {
          role: "assistant",
          text: "React is very popular for frontend work.",
          sessionId: "session-b",
          ts: "2026-01-15T09:00:01Z",
        },
        // Session C: user mentions both
        {
          role: "user",
          text: "After my chess game I usually write React components.",
          sessionId: "session-c",
          ts: "2026-02-01T18:00:00Z",
        },
      ],
      questions: [
        {
          question: "What hobby does the user have?",
          goldFacts: ["chess"],
          answer: "Playing chess",
          category: "multi-session",
        },
        {
          question: "What frontend framework does the user work with?",
          goldFacts: ["React", "frontend"],
          answer: "React",
          category: "multi-session",
        },
      ],
    },

    // ── Case 3: temporal (fact that changes over time) ─────────────────────────────────────────
    {
      id: "temporal-update",
      turns: [
        // Earlier state: lives in Berlin
        {
          role: "user",
          text: "I currently live in Berlin, Germany.",
          sessionId: "sess-t1",
          ts: "2025-06-01T08:00:00Z",
        },
        {
          role: "assistant",
          text: "Berlin is a wonderful city!",
          sessionId: "sess-t1",
          ts: "2025-06-01T08:00:01Z",
        },
        // Later update: moved to Amsterdam
        {
          role: "user",
          text: "I have moved to Amsterdam, Netherlands now.",
          sessionId: "sess-t2",
          ts: "2026-01-01T08:00:00Z",
        },
        {
          role: "assistant",
          text: "Amsterdam is beautiful! Enjoy your new home.",
          sessionId: "sess-t2",
          ts: "2026-01-01T08:00:01Z",
        },
      ],
      questions: [
        {
          // Asks for the current location — the LATEST fact (Amsterdam) must be retrievable.
          // Both Berlin and Amsterdam are ingested; the question focuses on the most recent.
          // Gold fact: "Amsterdam" must appear in retrieved context.
          question: "Where does the user currently live?",
          goldFacts: ["Amsterdam"],
          answer: "Amsterdam",
          category: "temporal",
        },
      ],
    },

    // ── Case 4: knowledge-update (fact contradicted later) ────────────────────────────────────
    {
      id: "knowledge-update-role",
      turns: [
        {
          role: "user",
          text: "I work as a junior developer at Acme Corp.",
          sessionId: "job-s1",
          ts: "2025-01-01T09:00:00Z",
        },
        {
          role: "assistant",
          text: "Exciting start at Acme Corp!",
          sessionId: "job-s1",
          ts: "2025-01-01T09:00:01Z",
        },
        {
          role: "user",
          text: "I got promoted to senior developer at Acme Corp.",
          sessionId: "job-s2",
          ts: "2026-01-01T09:00:00Z",
        },
        {
          role: "assistant",
          text: "Congratulations on your promotion to senior developer!",
          sessionId: "job-s2",
          ts: "2026-01-01T09:00:01Z",
        },
      ],
      questions: [
        {
          // The most recent turn about the role is "senior developer" — must be recalled.
          question: "What is the user's current job title?",
          goldFacts: ["senior developer", "Acme Corp"],
          answer: "Senior developer at Acme Corp",
          category: "knowledge-update",
        },
      ],
    },

    // ── Case 5: single-session with multiple distinct facts ───────────────────────────────────
    {
      id: "single-session-rich",
      turns: [
        {
          role: "user",
          text: "My dog is named Max and he is a golden retriever.",
          sessionId: "rich-s1",
        },
        {
          role: "assistant",
          text: "Max sounds wonderful! Golden retrievers are very friendly.",
          sessionId: "rich-s1",
        },
        {
          role: "user",
          text: "I run marathons and my personal best time is 3 hours 45 minutes.",
          sessionId: "rich-s1",
        },
        {
          role: "assistant",
          text: "That is an impressive marathon time!",
          sessionId: "rich-s1",
        },
        {
          role: "user",
          text: "I also enjoy cooking Italian food especially pasta carbonara.",
          sessionId: "rich-s1",
        },
      ],
      questions: [
        {
          question: "What is the user's dog's name and breed?",
          goldFacts: ["Max", "golden retriever"],
          answer: "Max, a golden retriever",
          category: "single-session",
        },
        {
          question: "What sport does the user participate in?",
          goldFacts: ["marathon"],
          answer: "Marathon running",
          category: "single-session",
        },
        {
          question: "What cuisine does the user enjoy cooking?",
          goldFacts: ["Italian", "pasta carbonara"],
          answer: "Italian food, especially pasta carbonara",
          category: "single-session",
        },
      ],
    },
  ],
};
