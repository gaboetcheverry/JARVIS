import { useState, useEffect, useCallback, type FormEvent } from 'react';
import { type User } from 'firebase/auth';
import {
  Mail,
  Search,
  Loader2,
  LogOut,
  RefreshCw,
  Sparkles,
  Inbox,
} from 'lucide-react';
import {
  initAuth,
  googleSignIn,
  logout,
  getAccessToken,
  clearAccessToken,
} from '../services/googleAuth';
import {
  searchGmailMessages,
  GmailAuthError,
  type GmailMessageItem,
} from '../services/gmailService';
import { getGeminiResponse, GeminiError } from '../services/geminiService';

export function GmailPanel() {
  const [needsAuth, setNeedsAuth] = useState(true);
  const [user, setUser] = useState<User | null>(null);
  const [accessToken, setAccessToken] = useState<string | null>(null);
  const [isLoggingIn, setIsLoggingIn] = useState(false);

  const [query, setQuery] = useState('Ice mexico');
  const [messages, setMessages] = useState<GmailMessageItem[]>([]);
  const [selectedMessage, setSelectedMessage] = useState<GmailMessageItem | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [summary, setSummary] = useState<string | null>(null);
  const [isSummarizing, setIsSummarizing] = useState(false);

  const runSearch = useCallback(async (token: string, searchQuery: string) => {
    setIsLoading(true);
    setError(null);
    setSummary(null);

    try {
      const results = await searchGmailMessages(token, searchQuery, 8);
      setMessages(results);
      setSelectedMessage(results[0] ?? null);
    } catch (err) {
      if (err instanceof GmailAuthError) {
        clearAccessToken();
        setAccessToken(null);
        setNeedsAuth(true);
      }
      setError(err instanceof Error ? err.message : 'No se pudo consultar Gmail.');
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    const unsubscribe = initAuth(
      (authedUser, token) => {
        setUser(authedUser);
        setAccessToken(token);
        setNeedsAuth(false);
      },
      () => {
        setAccessToken(null);
        setNeedsAuth(true);
      }
    );
    return () => unsubscribe();
  }, []);

  const handleLogin = async () => {
    setIsLoggingIn(true);
    setError(null);
    try {
      const result = await googleSignIn();
      if (result) {
        setUser(result.user);
        setAccessToken(result.accessToken);
        setNeedsAuth(false);
        await runSearch(result.accessToken, query);
      }
    } catch (err) {
      console.error('Google Sign-In failed:', err);
      setError('No se pudo completar el inicio de sesión con Google.');
    } finally {
      setIsLoggingIn(false);
    }
  };

  const handleLogout = async () => {
    await logout();
    setUser(null);
    setAccessToken(null);
    setMessages([]);
    setSelectedMessage(null);
    setSummary(null);
    setNeedsAuth(true);
  };

  const handleSearchSubmit = async (e: FormEvent) => {
    e.preventDefault();
    const token = accessToken || (await getAccessToken());
    if (!token) {
      setNeedsAuth(true);
      return;
    }
    await runSearch(token, query);
  };

  const handleQuickFilter = async (quickQuery: string) => {
    setQuery(quickQuery);
    const token = accessToken || (await getAccessToken());
    if (!token) {
      setNeedsAuth(true);
      return;
    }
    await runSearch(token, quickQuery);
  };

  const handleSummarize = async () => {
    if (!selectedMessage || isSummarizing) return;
    setIsSummarizing(true);
    setSummary(null);
    try {
      const prompt = `Resume este correo electrónico en español de forma muy clara, breve y directa en viñetas:\n\nDe: ${selectedMessage.from}\nAsunto: ${selectedMessage.subject}\nFecha: ${selectedMessage.date}\n\nContenido:\n${selectedMessage.body.slice(0, 6000)}`;
      const res = await getGeminiResponse(prompt, [], { model: 'gemini-4-hydrogen' });
      setSummary(res.text);
    } catch (err) {
      setSummary(
        err instanceof GeminiError || err instanceof Error
          ? err.message
          : 'No se pudo resumir el correo.'
      );
    } finally {
      setIsSummarizing(false);
    }
  };

  if (needsAuth) {
    return (
      <div className="bg-[#42d1f5]/5 border border-[#42d1f5]/25 rounded-lg p-8 text-center space-y-5">
        <Mail size={34} className="mx-auto text-[#42d1f5]" />
        <div className="space-y-2 max-w-md mx-auto">
          <h2 className="text-lg font-bold text-white tracking-wider uppercase">
            Módulo Gmail · J.A.R.V.Y.S.
          </h2>
          <p className="text-xs text-white/75 leading-relaxed">
            Inicia sesión con tu cuenta de Google para buscar y leer tus correos electrónicos (como tu último correo de <span className="text-[#42d1f5]">Ice Mexico</span>) directamente aquí.
          </p>
        </div>

        <div className="flex justify-center">
          <button
            type="button"
            onClick={() => void handleLogin()}
            disabled={isLoggingIn}
            className="gsi-material-button inline-flex items-center gap-3 bg-white text-[#1f1f1f] hover:bg-gray-100 rounded-full px-5 py-2.5 text-sm font-sans font-medium shadow-md cursor-pointer transition-colors disabled:opacity-60"
          >
            <span className="w-5 h-5 block shrink-0">
              <svg
                version="1.1"
                xmlns="http://www.w3.org/2000/svg"
                viewBox="0 0 48 48"
                className="block w-full h-full"
              >
                <path
                  fill="#EA4335"
                  d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z"
                />
                <path
                  fill="#4285F4"
                  d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z"
                />
                <path
                  fill="#FBBC05"
                  d="M10.53 28.59c-.48-1.45-.76-2.99-.76-4.59s.27-3.14.76-4.59l-7.98-6.19C.92 16.46 0 20.12 0 24c0 3.88.92 7.54 2.56 10.78l7.97-6.19z"
                />
                <path
                  fill="#34A853"
                  d="M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.15 1.45-4.92 2.3-8.16 2.3-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z"
                />
                <path fill="none" d="M0 0h48v48H0z" />
              </svg>
            </span>
            <span>{isLoggingIn ? 'Conectando...' : 'Sign in with Google'}</span>
          </button>
        </div>

        {error && (
          <p className="text-xs text-amber-300 max-w-md mx-auto">{error}</p>
        )}
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {/* Account & Search Header */}
      <div className="bg-[#42d1f5]/5 border border-[#42d1f5]/20 rounded-lg p-4 space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-2 text-xs">
          <div className="flex items-center gap-2 text-white/80">
            <Mail size={14} className="text-[#42d1f5]" />
            <span>{user?.email || 'Cuenta Google conectada'}</span>
          </div>
          <button
            type="button"
            onClick={() => void handleLogout()}
            className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded border border-[#42d1f5]/30 hover:bg-[#42d1f5]/15 text-xs cursor-pointer"
          >
            <LogOut size={12} />
            <span>Desconectar</span>
          </button>
        </div>

        <form onSubmit={(e) => void handleSearchSubmit(e)} className="flex gap-2">
          <div className="flex-1 flex items-center bg-black/50 border border-[#42d1f5]/25 rounded-lg px-3 py-2">
            <Search size={14} className="text-[#42d1f5]/60 mr-2 shrink-0" />
            <input
              type="text"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Buscar correos (ej. Ice mexico, from:..., asunto)..."
              className="w-full bg-transparent text-sm text-white placeholder-[#42d1f5]/40 focus:outline-none"
            />
          </div>
          <button
            type="submit"
            disabled={isLoading}
            className="px-4 py-2 rounded-lg border border-[#42d1f5]/40 bg-[#42d1f5]/15 hover:bg-[#42d1f5]/25 text-xs uppercase tracking-wider flex items-center gap-1.5 cursor-pointer disabled:opacity-50"
          >
            {isLoading ? <Loader2 size={14} className="animate-spin" /> : <RefreshCw size={14} />}
            <span>Buscar</span>
          </button>
        </form>

        <div className="flex flex-wrap items-center gap-2 text-[11px]">
          <span className="opacity-60 uppercase tracking-wider">Accesos rápidos:</span>
          <button
            type="button"
            onClick={() => void handleQuickFilter('Ice mexico')}
            className="px-2.5 py-1 rounded border border-[#42d1f5]/30 bg-black/40 hover:bg-[#42d1f5]/15 cursor-pointer"
          >
            Ice mexico
          </button>
          <button
            type="button"
            onClick={() => void handleQuickFilter('')}
            className="px-2.5 py-1 rounded border border-[#42d1f5]/30 bg-black/40 hover:bg-[#42d1f5]/15 cursor-pointer"
          >
            Recientes
          </button>
        </div>
      </div>

      {error && (
        <div className="p-3 rounded border border-amber-500/40 bg-amber-500/10 text-amber-200 text-xs">
          {error}
        </div>
      )}

      {/* Email List + Reader */}
      <div className="grid grid-cols-1 md:grid-cols-12 gap-4">
        <div className="md:col-span-5 bg-[#42d1f5]/5 border border-[#42d1f5]/20 rounded-lg p-3 max-h-[460px] overflow-y-auto space-y-2">
          <div className="flex items-center gap-2 text-[10px] uppercase tracking-widest opacity-60 pb-1 border-b border-[#42d1f5]/15">
            <Inbox size={12} />
            <span>Resultados ({messages.length})</span>
          </div>

          {isLoading ? (
            <div className="py-10 flex items-center justify-center gap-2 text-xs opacity-70">
              <Loader2 size={15} className="animate-spin" />
              <span>Consultando Gmail...</span>
            </div>
          ) : messages.length === 0 ? (
            <p className="py-8 text-center text-xs opacity-60">
              No se encontraron correos para &ldquo;{query || 'recientes'}&rdquo;.
            </p>
          ) : (
            messages.map((msg) => {
              const active = selectedMessage?.id === msg.id;
              return (
                <button
                  key={msg.id}
                  type="button"
                  onClick={() => {
                    setSelectedMessage(msg);
                    setSummary(null);
                  }}
                  className={`w-full text-left p-3 rounded border transition-colors cursor-pointer space-y-1 ${
                    active
                      ? 'bg-[#42d1f5]/20 border-[#42d1f5] text-white'
                      : 'bg-black/40 border-[#42d1f5]/15 text-[#42d1f5]/85 hover:border-[#42d1f5]/45'
                  }`}
                >
                  <p className="text-xs font-bold truncate">{msg.subject}</p>
                  <p className="text-[11px] text-white/70 truncate">{msg.from}</p>
                  <p className="text-[10px] opacity-55 truncate">{msg.date}</p>
                </button>
              );
            })
          )}
        </div>

        <div className="md:col-span-7 bg-[#42d1f5]/5 border border-[#42d1f5]/20 rounded-lg p-4 max-h-[460px] overflow-y-auto space-y-3">
          {selectedMessage ? (
            <>
              <div className="border-b border-[#42d1f5]/15 pb-3 space-y-1.5">
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <h3 className="text-sm font-bold text-white leading-snug">
                    {selectedMessage.subject}
                  </h3>
                  <button
                    type="button"
                    onClick={() => void handleSummarize()}
                    disabled={isSummarizing}
                    className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded border border-[#42d1f5]/40 bg-[#42d1f5]/15 hover:bg-[#42d1f5]/25 text-[11px] cursor-pointer disabled:opacity-50 shrink-0"
                  >
                    {isSummarizing ? (
                      <Loader2 size={12} className="animate-spin" />
                    ) : (
                      <Sparkles size={12} />
                    )}
                    <span>Resumir con J.A.R.V.Y.S.</span>
                  </button>
                </div>
                <p className="text-xs text-white/75">De: {selectedMessage.from}</p>
                <p className="text-[11px] opacity-60">Fecha: {selectedMessage.date}</p>
              </div>

              {summary && (
                <div className="p-3 rounded border border-[#42d1f5]/35 bg-[#42d1f5]/10 text-xs text-white whitespace-pre-wrap space-y-1">
                  <span className="text-[10px] uppercase tracking-wider text-[#42d1f5] block">
                    Resumen Stark:
                  </span>
                  <p>{summary}</p>
                </div>
              )}

              <div className="text-xs text-white/85 whitespace-pre-wrap leading-relaxed font-sans">
                {selectedMessage.body || selectedMessage.snippet}
              </div>
            </>
          ) : (
            <div className="py-16 text-center text-xs opacity-60">
              Selecciona un correo de la lista para ver su contenido completo.
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
