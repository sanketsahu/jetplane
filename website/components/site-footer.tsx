import Link from 'next/link'
import { ArrowUpRight } from 'lucide-react'

// Root-relative assets in public/ need the deploy subpath prepended manually —
// next/link and next/image add basePath automatically, a raw <img src> does not.
const BASE_PATH = process.env.NEXT_PUBLIC_BASE_PATH || ''
const asset = (p: string) => (p.startsWith('/') ? BASE_PATH + p : p)

// Family-site logos are loaded from their own domains, so they stay in sync when those
// sites update. RapidNative has no published logo URL, so it stays vendored.
const RELATED = [
  { name: 'Lifo', href: 'https://lifo.sh', logo: 'https://lifo.sh/brand/lifo-logo.svg', desc: 'Linux APIs in the browser — run real dev tooling with no VM, no container.' },
  { name: 'tinbase', href: 'https://tinbase.dev', logo: 'https://tinbase.dev/logo.svg', desc: 'An open-source, Supabase-compatible backend that runs anywhere — pure TypeScript, Postgres in the browser.' },
  { name: 'ORCHD', href: 'https://rapidnative.github.io/orchd', logo: 'https://rapidnative.github.io/orchd/logo.svg', desc: 'A multi-tenant workload orchestrator — every tenant gets a hostname, sleeps when idle, wakes in about a second.' },
  { name: 'RapidNative', href: 'https://rapidnative.com', logo: '/logos/rapidnative.svg', desc: 'AI that generates production-ready React Native apps and UIs from a prompt.' },
]

function GitHubIcon() {
  return (
    <svg viewBox="0 0 16 16" width="16" height="16" fill="currentColor" aria-hidden>
      <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.01 8.01 0 0016 8c0-4.42-3.58-8-8-8z" />
    </svg>
  )
}
function XIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" className="size-4" aria-hidden>
      <path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z" />
    </svg>
  )
}

export function SiteFooter() {
  return (
    <footer className="border-t border-border">
      {/* From the same team — related projects */}
      <div className="border-b border-border px-6 py-12">
        <div className="mx-auto max-w-6xl">
          <p className="text-xs font-semibold uppercase tracking-[0.2em] text-brand">From the same team</p>
          <h2 className="mt-2 text-lg font-bold tracking-tight text-foreground">Related projects</h2>
          <p className="mt-1 max-w-2xl text-sm text-muted-foreground">
            jetplane is built by the makers of these open-source tools and products.
          </p>
          <div className="mt-6 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            {RELATED.map((p) => (
              <a
                key={p.name}
                href={p.href}
                target="_blank"
                rel="noopener noreferrer"
                className="group flex items-start gap-4 rounded-xl border border-border bg-card/40 p-4 transition-colors hover:border-brand/40"
              >
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src={asset(p.logo)} alt={`${p.name} logo`} width={36} height={36} className="size-9 shrink-0 rounded-md" />
                <div className="min-w-0">
                  <span className="inline-flex items-center gap-1 font-semibold text-foreground group-hover:text-brand">
                    {p.name}
                    <ArrowUpRight className="size-3.5 text-muted-foreground group-hover:text-brand" />
                  </span>
                  <p className="mt-0.5 text-sm leading-relaxed text-muted-foreground">{p.desc}</p>
                </div>
              </a>
            ))}
          </div>
        </div>
      </div>

      {/* Base footer */}
      <div className="px-6 py-8">
        <div className="mx-auto flex max-w-6xl flex-col items-center gap-4 text-center text-sm text-muted-foreground">
          <p>
            Built by the makers of{' '}
            <a href="https://rapidnative.com" target="_blank" rel="noopener noreferrer" className="text-foreground underline underline-offset-4 hover:text-brand">
              RapidNative
            </a>{' '}
            in Bangalore · Core:{' '}
            <a href="https://x.com/sanketsahu" target="_blank" rel="noopener noreferrer" className="text-foreground underline underline-offset-4 hover:text-brand">
              Sanket Sahu
            </a>
          </p>
          <p>
            Looking for an AI-native product team?{' '}
            <a href="https://geekyants.com" target="_blank" rel="noopener noreferrer" className="text-foreground underline underline-offset-4 hover:text-brand">
              GeekyAnts
            </a>{' '}
            offers AI consulting and engineering for startups and enterprises.
          </p>
          <div className="flex items-center gap-5">
            <Link href="/docs" className="hover:text-foreground">Docs</Link>
            <a href="https://www.npmjs.com/package/jetplane" className="hover:text-foreground">npm</a>
            <a href="https://x.com/sanketsahu" aria-label="Sanket Sahu on X" className="hover:text-foreground"><XIcon /></a>
            <a href="https://github.com/sanketsahu/jetplane" aria-label="jetplane on GitHub" className="flex items-center hover:text-foreground"><GitHubIcon /></a>
          </div>
          <p className="text-xs">Open source under MIT · not affiliated with Meta, Expo, or the React Native team.</p>
        </div>
      </div>
    </footer>
  )
}
