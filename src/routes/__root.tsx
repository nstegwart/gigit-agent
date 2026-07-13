import { Suspense } from 'react'
import {
  HeadContent,
  Scripts,
  createRootRouteWithContext,
} from '@tanstack/react-router'
import { TanStackRouterDevtoolsPanel } from '@tanstack/react-router-devtools'
import { TanStackDevtools } from '@tanstack/react-devtools'

import TanStackQueryDevtools from '../integrations/tanstack-query/devtools'
import { meQueryOptions } from '#/lib/board-query'
import { clearCsrfTokenCache, getCsrfToken } from '#/lib/csrf-client'
import { meFn } from '#/server/auth-fns'

import appCss from '../styles.css?url'

import type { QueryClient } from '@tanstack/react-query'
import type { SessionUser } from '#/lib/types'

interface MyRouterContext {
  queryClient: QueryClient
}

const THEME_INIT = `(function(){try{var t=localStorage.getItem('cairn-theme');var u=new URLSearchParams(location.search).get('theme');if(u==='dark'||u==='light')t=u;if(t==='dark'||t==='light')document.documentElement.setAttribute('data-theme',t);}catch(e){}})();`

export const Route = createRootRouteWithContext<MyRouterContext>()({
  // Resolve the signed-in human once per navigation; child routes redirect on it.
  beforeLoad: async ({ context }): Promise<{ me: SessionUser | null }> => {
    const me = await meFn()
    context.queryClient.setQueryData(meQueryOptions().queryKey, me)
    // Browser only: warm session CSRF cache for cookie mutations; never SSR-cache (cross-request leak).
    if (typeof window !== 'undefined') {
      if (me) {
        void getCsrfToken().catch(() => {
          /* mutations still fail-closed on demand */
        })
      } else {
        clearCsrfTokenCache()
      }
    }
    return { me }
  },
  head: () => ({
    meta: [
      { charSet: 'utf-8' },
      { name: 'viewport', content: 'width=device-width, initial-scale=1' },
      // Document title for shell a11y (WCAG 2.4.2); keep meaningful, product-facing.
      { title: 'Cairn — agent work board' },
      {
        name: 'description',
        content:
          'Lightweight, agent-native work board: projects → features → tasks, with live agent runtime.',
      },
    ],
    links: [{ rel: 'stylesheet', href: appCss }],
  }),
  shellComponent: RootDocument,
})

function RootDocument({ children }: { children: React.ReactNode }) {
  // Root lang required for html-has-lang / screen-reader language announcement.
  return (
    <html lang="en">
      <head>
        <HeadContent />
        <script dangerouslySetInnerHTML={{ __html: THEME_INIT }} />
      </head>
      <body>
        <Suspense fallback={null}>{children}</Suspense>
        <TanStackDevtools
          config={{ position: 'bottom-right' }}
          plugins={[
            { name: 'Tanstack Router', render: <TanStackRouterDevtoolsPanel /> },
            TanStackQueryDevtools,
          ]}
        />
        <Scripts />
      </body>
    </html>
  )
}
