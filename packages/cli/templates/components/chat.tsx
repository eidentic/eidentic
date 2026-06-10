// Copied by `eidentic add component` — yours to edit.
"use client";

import React, { useRef, useEffect, type KeyboardEvent, type FormEvent } from "react";
import { useAgent } from "@eidentic/react";
import type { TextMessage, ToolCall } from "@eidentic/react";

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

export interface EidenticChatProps {
  /** Agent ID registered in the Eidentic server. */
  agentId: string;
  /** Base URL of the Eidentic server. Defaults to same-origin (""). */
  baseUrl?: string;
  /** Placeholder text for the input field. */
  placeholder?: string;
  /** Class name applied to the outermost container. */
  className?: string;
}

// ---------------------------------------------------------------------------
// Sub-components
// ---------------------------------------------------------------------------

function MessageBubble({ message }: { message: TextMessage }) {
  return (
    <div className="flex justify-end">
      <div className="max-w-[80%] rounded-2xl rounded-br-sm bg-indigo-500 px-4 py-2 text-sm text-white">
        {message.content}
      </div>
    </div>
  );
}

function AssistantBubble({ message }: { message: TextMessage }) {
  return (
    <div className="flex justify-start">
      <div className="max-w-[80%] rounded-2xl rounded-bl-sm bg-white px-4 py-2 text-sm text-zinc-800 shadow-sm">
        {message.content}
        {message.streaming && (
          <span className="ml-1 inline-block h-3 w-1 animate-pulse rounded-sm bg-indigo-400" aria-hidden="true" />
        )}
      </div>
    </div>
  );
}

function ToolChip({ call }: { call: ToolCall }) {
  return (
    <div
      role="status"
      aria-label={`Tool call: ${call.name}`}
      className="flex items-center gap-1.5 rounded-full border border-indigo-200 bg-indigo-50 px-3 py-1 text-xs text-indigo-700"
    >
      <span className="h-1.5 w-1.5 rounded-full bg-indigo-400" aria-hidden="true" />
      <span className="font-mono">{call.name}</span>
    </div>
  );
}

// ---------------------------------------------------------------------------
// EidenticChat
// ---------------------------------------------------------------------------

/**
 * Drop-in chat UI for a Eidentic agent.
 *
 * Usage:
 *   <EidenticChat agentId="my-agent" baseUrl="http://localhost:3000" />
 */
export function EidenticChat({
  agentId,
  baseUrl = "",
  placeholder = "Type a message…",
  className = "",
}: EidenticChatProps) {
  const { messages, toolCalls, result, status, error, send, stop } = useAgent(agentId, baseUrl);

  const inputRef = useRef<HTMLTextAreaElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);

  // Autoscroll to bottom on new messages.
  useEffect(() => {
    const el = scrollRef.current;
    if (el) {
      el.scrollTop = el.scrollHeight;
    }
  }, [messages, toolCalls]);

  const isStreaming = status === "streaming";

  function handleSubmit(e: FormEvent) {
    e.preventDefault();
    const val = inputRef.current?.value.trim();
    if (!val || isStreaming) return;
    if (inputRef.current) inputRef.current.value = "";
    send(val);
  }

  function handleKeyDown(e: KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      const val = inputRef.current?.value.trim();
      if (!val || isStreaming) return;
      if (inputRef.current) inputRef.current.value = "";
      send(val);
    }
  }

  // Format USD cost when available.
  const costDisplay =
    result?.cost?.usd != null ? `$${result.cost.usd.toFixed(6)}` : null;
  const usageDisplay =
    result?.usage != null
      ? `${result.usage.inputTokens + result.usage.outputTokens} tokens`
      : null;

  return (
    <div
      className={`flex h-full flex-col rounded-2xl border border-zinc-200 bg-zinc-50 shadow-sm ${className}`}
      role="region"
      aria-label="Eidentic chat"
    >
      {/* Message list */}
      <div
        ref={scrollRef}
        className="flex-1 overflow-y-auto space-y-3 px-4 py-4"
        role="log"
        aria-live="polite"
        aria-label="Conversation"
      >
        {messages.length === 0 && !isStreaming && (
          <p className="text-center text-sm text-zinc-400">
            Send a message to start the conversation.
          </p>
        )}

        {messages.map((msg, i) =>
          msg.role === "assistant" ? (
            <AssistantBubble key={i} message={msg} />
          ) : (
            <MessageBubble key={i} message={msg} />
          ),
        )}

        {/* Tool-call chips */}
        {toolCalls.length > 0 && (
          <div className="flex flex-wrap gap-2 pt-1" aria-label="Active tool calls">
            {toolCalls.map((tc) => (
              <ToolChip key={tc.callId} call={tc} />
            ))}
          </div>
        )}

        {/* Error */}
        {error && (
          <div
            role="alert"
            className="rounded-lg border border-red-200 bg-red-50 px-4 py-2 text-sm text-red-700"
          >
            {error.message}
          </div>
        )}
      </div>

      {/* Footer: usage + cost */}
      {(usageDisplay || costDisplay) && (
        <div
          className="flex items-center gap-3 border-t border-zinc-100 px-4 py-1.5 text-xs text-zinc-400"
          aria-label="Usage summary"
        >
          {usageDisplay && <span>{usageDisplay}</span>}
          {costDisplay && <span>{costDisplay}</span>}
        </div>
      )}

      {/* Input */}
      <form
        onSubmit={handleSubmit}
        className="flex items-end gap-2 border-t border-zinc-200 px-3 py-3"
        aria-label="Message input"
      >
        <label htmlFor="eidentic-chat-input" className="sr-only">
          Message
        </label>
        <textarea
          id="eidentic-chat-input"
          ref={inputRef}
          rows={1}
          placeholder={placeholder}
          disabled={isStreaming}
          onKeyDown={handleKeyDown}
          className="flex-1 resize-none rounded-xl border border-zinc-300 bg-white px-3 py-2 text-sm text-zinc-800 placeholder-zinc-400 outline-none focus:border-indigo-500 focus:ring-2 focus:ring-indigo-200 disabled:opacity-60"
          aria-multiline="true"
        />
        {isStreaming ? (
          <button
            type="button"
            onClick={stop}
            aria-label="Stop generation"
            className="flex h-9 w-9 items-center justify-center rounded-xl bg-zinc-200 text-zinc-600 hover:bg-zinc-300 focus-visible:outline-2 focus-visible:outline-indigo-500"
          >
            <span className="block h-3.5 w-3.5 rounded-sm bg-current" aria-hidden="true" />
          </button>
        ) : (
          <button
            type="submit"
            aria-label="Send message"
            className="flex h-9 w-9 items-center justify-center rounded-xl bg-indigo-500 text-white hover:bg-indigo-600 focus-visible:outline-2 focus-visible:outline-indigo-500 disabled:opacity-50"
          >
            <svg
              viewBox="0 0 16 16"
              fill="currentColor"
              className="h-4 w-4"
              aria-hidden="true"
            >
              <path d="M8 2.5a.75.75 0 0 1 .75.75v7.19l2.47-2.47a.75.75 0 1 1 1.06 1.06l-3.75 3.75a.75.75 0 0 1-1.06 0L3.72 9.03a.75.75 0 1 1 1.06-1.06L7.25 10.44V3.25A.75.75 0 0 1 8 2.5Z" />
            </svg>
          </button>
        )}
      </form>
    </div>
  );
}
