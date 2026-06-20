'use client'

import {useMemo, useState} from 'react'

import type {CommandMeta} from '../lib/types'

import {ThemeToggle} from './theme-toggle'

export function CommandList({
  bin,
  commands,
  onSelect,
  query,
  selectedId,
  setQuery,
  version,
}: {
  bin: string
  commands: CommandMeta[]
  onSelect: (id: string) => void
  query: string
  selectedId?: string
  setQuery: (q: string) => void
  version: string
}) {
  const [topic, setTopic] = useState('all')
  const topics = useMemo(() => {
    const counts = new Map<string, number>()
    for (const command of commands) {
      const commandTopic = command.id.split(':', 1)[0]
      counts.set(commandTopic, (counts.get(commandTopic) ?? 0) + 1)
    }

    return [...counts].sort(([a], [b]) => a.localeCompare(b))
  }, [commands])

  const filtered = commands.filter((cmd) => {
    if (topic !== 'all' && cmd.id.split(':', 1)[0] !== topic) return false
    if (!query) return true
    const haystack = `${cmd.id} ${cmd.summary ?? ''} ${cmd.description ?? ''}`.toLowerCase()
    return query
      .toLowerCase()
      .split(/\s+/)
      .every((term) => haystack.includes(term))
  })

  return (
    <aside className="sidebar">
      <div className="sidebar-header">
        <div className="brand-row">
          <div className="brand">
            {bin || 'sdkck'} <small>web UI · v{version}</small>
          </div>
          <ThemeToggle />
        </div>
        <input
          aria-label="Filter commands"
          className="search"
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Filter commands…"
          type="text"
          value={query}
        />
        <div className="topic-filter">
          <label htmlFor="topic">Topic</label>
          <select id="topic" onChange={(event) => setTopic(event.target.value)} value={topic}>
            <option value="all">All topics ({commands.length})</option>
            {topics.map(([name, count]) => (
              <option key={name} value={name}>
                {name} ({count})
              </option>
            ))}
          </select>
        </div>
      </div>
      <nav className="command-list">
        {filtered.length === 0 && <div className="empty">No commands match.</div>}
        {topics.map(([name]) => {
          const topicCommands = filtered.filter((command) => command.id.split(':', 1)[0] === name)
          if (topicCommands.length === 0) return null

          return (
            <section className="command-group" key={name}>
              <div className="topic-heading">
                <span>{name}</span>
                <span>{topicCommands.length}</span>
              </div>
              {topicCommands.map((cmd) => (
                <button
                  className={`command-item${cmd.id === selectedId ? ' active' : ''}`}
                  key={cmd.id}
                  onClick={() => onSelect(cmd.id)}
                  type="button"
                >
                  <span className="cmd-id">{cmd.id}</span>
                  <span className="cmd-summary">{cmd.summary ?? cmd.description ?? ''}</span>
                </button>
              ))}
            </section>
          )
        })}
      </nav>
    </aside>
  )
}
