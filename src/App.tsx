/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { useState, useEffect, useRef, useMemo, type FormEvent } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import {
  Mic,
  MicOff,
  Volume2,
  VolumeX,
  Shield,
  Zap,
  Clock,
  Globe,
  Terminal,
  Send,
  ExternalLink,
  Trash2,
  MapPin,
  Image as ImageIcon,
  Film,
  SlidersHorizontal,
  Search,
  Bot,
  Mail,
  Download,
  Loader2,
} from 'lucide-react';
import {
  getGeminiResponse,
  getGeminiTTS,
  pollVideoGeneration,
  fetchPublicConfig,
  GeminiError,
  GeminiErrorType,
  type ChatModelId,
  type ChatTurn,
} from './services/geminiService';
import { getAccessToken, clearAccessToken } from './services/googleAuth';
import { searchGmailMessages, GmailAuthError } from './services/gmailService';
import { MapsPanel } from './components/MapsPanel';
import { MediaStudioPanel } from './components/MediaStudioPanel';
import { GmailPanel } from './components/GmailPanel';

declare global {
  interface Window {
    SpeechRecognition: any;
    webkitSpeechRecognition: any;
  }
}

type ActiveTab = 'core' | 'maps' | 'image' | 'video' | 'gmail';

interface ActionLink {
  label: string;
  url: string;
}

const MODEL_OPTIONS: Array<{ id: ChatModelId; label: string; hint: string }> = [
  { id: 'gemini-4-hydrogen', label: 'Hydrogen', hint: 'General (Predeterminado)' },
  { id: 'gemini-3.1-flash-lite', label: 'Flash Lite', hint: 'Ultra rápido' },
  { id: 'gemini-4-argon', label: 'Argon', hint: 'Tareas complejas' },
  { id: 'gemini-4-carbon', label: 'Carbon', hint: 'Razonamiento profundo' },
];

const ROLE_PRESETS: Array<{ id: string; label: string; instruction: string }> = [
  {
    id: 'jarvis',
    label: 'J.A.R.V.Y.S. (Asistente Stark)',
    instruction:
      "Eres J.A.R.V.Y.S., el asistente de inteligencia artificial personal de Tony Stark. Eres servicial, eficiente, con un tono calmado y profesional, llamando al usuario 'Señor'. Tus respuestas deben ser MUY cortas, directas y elegantes. Evita explicaciones largas a menos que se te pida. Mantén el estilo sofisticado de las películas de Iron Man. Responde siempre en español.",
  },
  {
    id: 'analyst',
    label: 'Analista Técnico',
    instruction:
      'Eres un ingeniero y analista técnico senior. Responde en español con precisión técnica, estructura clara y pasos accionables sin rodeos innecesarios.',
  },
  {
    id: 'researcher',
    label: 'Investigador Web',
    instruction:
      'Eres un investigador analítico especializado en síntesis de información verificada. Responde en español citando hechos concretos y manteniendo brevedad.',
  },
  {
    id: 'creative',
    label: 'Director Creativo',
    instruction:
      'Eres un director creativo experto en narrativa, diseño visual y cine. Responde en español con ideas originales, concretas y evocadoras.',
  },
];

export default function App() {
  const [activeTab, setActiveTab] = useState<ActiveTab>('core');
  const [mapsQuotaExceeded, setMapsQuotaExceeded] = useState(false);
  const [mapsApiKey, setMapsApiKey] = useState<string>(
    import.meta.env.VITE_GOOGLE_MAPS_API_KEY || ''
  );
  const [sharedImageUrl, setSharedImageUrl] = useState<string | null>(null);
  const [mapInitialQuery, setMapInitialQuery] = useState<string>('');

  // Voice & Core HUD state
  const [isListening, setIsListening] = useState(false);
  const [isSpeaking, setIsSpeaking] = useState(false);
  const [isProcessing, setIsProcessing] = useState(false);
  const [isMuted, setIsMuted] = useState(false);
  const [speechSupported, setSpeechSupported] = useState(true);
  const [currentTime, setCurrentTime] = useState(new Date().toLocaleTimeString());

  // Chat configuration & multi-turn thread state
  const [selectedModel, setSelectedModel] = useState<ChatModelId>('gemini-4-hydrogen');
  const [useSearch, setUseSearch] = useState(false);
  const [selectedRoleId, setSelectedRoleId] = useState<string>('jarvis');
  const [systemInstruction, setSystemInstruction] = useState<string>(
    ROLE_PRESETS[0].instruction
  );
  const [showConfig, setShowConfig] = useState(false);

  const [textInput, setTextInput] = useState('');
  const [transcript, setTranscript] = useState('');
  const [actionLink, setActionLink] = useState<ActionLink | null>(null);
  const [history, setHistory] = useState<ChatTurn[]>([
    {
      role: 'jarvis',
      text: 'Sistemas en línea, Señor. Todos los módulos están operativos. ¿En qué puedo ayudarle hoy?',
      modelUsed: 'gemini-4-hydrogen',
    },
  ]);

  const sessionId = useMemo(
    () => Math.random().toString(36).substring(2, 8).toUpperCase(),
    []
  );

  const recognitionRef = useRef<any>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const chatScrollRef = useRef<HTMLDivElement | null>(null);
  const historyRef = useRef<ChatTurn[]>(history);
  const isMutedRef = useRef(false);
  const selectedModelRef = useRef<ChatModelId>(selectedModel);
  const useSearchRef = useRef<boolean>(useSearch);
  const systemInstructionRef = useRef<string>(systemInstruction);
  const speakTokenRef = useRef(0);
  const processCommandRef = useRef<(command: string) => Promise<void>>(async () => {});

  useEffect(() => {
    historyRef.current = history;
    if (chatScrollRef.current) {
      chatScrollRef.current.scrollTop = chatScrollRef.current.scrollHeight;
    }
  }, [history]);

  useEffect(() => {
    isMutedRef.current = isMuted;
  }, [isMuted]);

  useEffect(() => {
    selectedModelRef.current = selectedModel;
  }, [selectedModel]);

  useEffect(() => {
    useSearchRef.current = useSearch;
  }, [useSearch]);

  useEffect(() => {
    systemInstructionRef.current = systemInstruction;
  }, [systemInstruction]);

  useEffect(() => {
    const timer = setInterval(() => {
      setCurrentTime(new Date().toLocaleTimeString());
    }, 1000);
    return () => clearInterval(timer);
  }, []);

  // Top-level Case A Demo Key quota listener (persists across all tabs)
  useEffect(() => {
    const handleQuotaExceeded = () => {
      setMapsQuotaExceeded(true);
    };
    window.addEventListener('gmp-quota-exceeded', handleQuotaExceeded);
    return () => {
      window.removeEventListener('gmp-quota-exceeded', handleQuotaExceeded);
    };
  }, []);

  // Fetch server-side public config if VITE_GOOGLE_MAPS_API_KEY was not baked at build time
  useEffect(() => {
    if (mapsApiKey) return;
    let active = true;
    fetchPublicConfig().then((cfg) => {
      if (active && cfg.mapsApiKey) {
        setMapsApiKey(cfg.mapsApiKey);
      }
    });
    return () => {
      active = false;
    };
  }, [mapsApiKey]);

  const stopAudio = () => {
    speakTokenRef.current += 1;
    if (audioRef.current) {
      audioRef.current.pause();
      const oldUrl = audioRef.current.src;
      if (oldUrl.startsWith('blob:')) {
        URL.revokeObjectURL(oldUrl);
      }
      audioRef.current.src = '';
    }
    if (typeof window !== 'undefined' && 'speechSynthesis' in window) {
      window.speechSynthesis.cancel();
    }
    setIsSpeaking(false);
  };

  const speak = async (text: string) => {
    if (!text || text.trim() === '') return;

    stopAudio();
    if (isMutedRef.current) return;

    const currentToken = speakTokenRef.current;
    setIsSpeaking(true);

    const audioUrl = await getGeminiTTS(text);
    if (currentToken !== speakTokenRef.current || isMutedRef.current) {
      if (audioUrl) URL.revokeObjectURL(audioUrl);
      setIsSpeaking(false);
      return;
    }

    if (audioUrl) {
      if (audioRef.current) {
        audioRef.current.src = audioUrl;
        audioRef.current.loop = false;
        audioRef.current.muted = isMutedRef.current;
        audioRef.current.onended = () => {
          setIsSpeaking(false);
          if (audioRef.current) {
            audioRef.current.src = '';
          }
          URL.revokeObjectURL(audioUrl);
        };
        audioRef.current.play().catch((err) => {
          console.error('Audio playback failed:', err);
          URL.revokeObjectURL(audioUrl);
          setIsSpeaking(false);
        });
      }
    } else if (typeof window !== 'undefined' && 'speechSynthesis' in window) {
      const utterance = new SpeechSynthesisUtterance(text);
      utterance.lang = 'es-ES';
      utterance.rate = 1.0;
      utterance.onend = () => setIsSpeaking(false);
      utterance.onerror = () => setIsSpeaking(false);
      window.speechSynthesis.speak(utterance);
    } else {
      setIsSpeaking(false);
    }
  };

  const processCommand = async (command: string) => {
    const trimmed = command.trim();
    if (!trimmed) return;

    const lowerCommand = trimmed.toLowerCase();
    const priorHistory = historyRef.current;
    setTranscript(trimmed);
    setActionLink(null);
    setHistory((prev) => [...prev, { role: 'user', text: trimmed }]);

    // Local quick commands
    if (lowerCommand.includes('abre youtube')) {
      const msg = 'Abriendo YouTube, Señor.';
      setActionLink({ label: 'Abrir YouTube', url: 'https://www.youtube.com' });
      setHistory((prev) => [...prev, { role: 'jarvis', text: msg }]);
      speak(msg);
      return;
    }

    if (lowerCommand.includes('abre google')) {
      const msg = 'Accediendo a Google, Señor.';
      setActionLink({ label: 'Abrir Google', url: 'https://www.google.com' });
      setHistory((prev) => [...prev, { role: 'jarvis', text: msg }]);
      speak(msg);
      return;
    }

    if (
      lowerCommand === 'hora' ||
      lowerCommand.includes('qué hora es') ||
      lowerCommand.includes('que hora es') ||
      lowerCommand.includes('dime la hora')
    ) {
      const msg = `Señor, la hora actual es ${new Date().toLocaleTimeString()}.`;
      setHistory((prev) => [...prev, { role: 'jarvis', text: msg }]);
      speak(msg);
      return;
    }

    // Gemini Response
    try {
      setIsProcessing(true);
      const result = await getGeminiResponse(trimmed, priorHistory, {
        model: selectedModelRef.current,
        systemInstruction: systemInstructionRef.current,
        useSearch: useSearchRef.current,
      });

      if (result.imageUrl) {
        setSharedImageUrl(result.imageUrl);
        setHistory((prev) => [
          ...prev,
          {
            role: 'jarvis',
            text: result.text || 'Imagen generada, Señor.',
            imageUrl: result.imageUrl,
            sources: result.sources,
            modelUsed: result.modelUsed,
            navigateTab: { label: 'Abrir en Estudio Imagen', tab: 'image' },
          },
        ]);
        speak(result.text || 'Imagen generada, Señor.');
      } else if (result.videoInteractionId) {
        const interactionId = result.videoInteractionId;
        setHistory((prev) => [
          ...prev,
          {
            role: 'jarvis',
            text: result.text,
            videoUrl: result.videoUrl,
            videoInteractionId: result.videoUrl ? undefined : interactionId,
            modelUsed: result.modelUsed,
          },
        ]);
        speak(result.text);

        if (!result.videoUrl) {
          const pollInlineVideo = async (attempts: number) => {
            if (attempts > 60) {
              setHistory((prev) =>
                prev.map((item) =>
                  item.videoInteractionId === interactionId
                    ? {
                        ...item,
                        videoInteractionId: undefined,
                        text: 'Tiempo de espera agotado al generar el video, Señor.',
                      }
                    : item
                )
              );
              return;
            }
            try {
              const statusRes = await pollVideoGeneration(interactionId);
              if (statusRes.status === 'completed' && statusRes.videoUrl) {
                setHistory((prev) =>
                  prev.map((item) =>
                    item.videoInteractionId === interactionId
                      ? {
                          ...item,
                          videoInteractionId: undefined,
                          videoUrl: statusRes.videoUrl,
                          text: 'Señor, el video ya está listo.',
                        }
                      : item
                  )
                );
                speak('Señor, el video ya está listo.');
              } else {
                window.setTimeout(() => void pollInlineVideo(attempts + 1), 4000);
              }
            } catch {
              setHistory((prev) =>
                prev.map((item) =>
                  item.videoInteractionId === interactionId
                    ? {
                        ...item,
                        videoInteractionId: undefined,
                        text: 'Señor, ocurrió un error al completar el video.',
                      }
                    : item
                )
              );
            }
          };
          window.setTimeout(() => void pollInlineVideo(1), 4000);
        }
      } else if (result.clientAction?.type === 'gmail_search') {
        const gmailQuery = result.clientAction.query;
        const token = await getAccessToken();
        if (!token) {
          const authMsg =
            'Señor, aún no ha iniciado sesión en Gmail. Entre en la pestaña Correo para conectar su cuenta y buscar sus mensajes.';
          setHistory((prev) => [
            ...prev,
            {
              role: 'jarvis',
              text: authMsg,
              modelUsed: result.modelUsed,
              navigateTab: { label: 'Ir a Correo (Gmail)', tab: 'gmail' },
            },
          ]);
          speak(authMsg);
        } else {
          try {
            const found = await searchGmailMessages(token, gmailQuery, 3);
            if (found.length === 0) {
              const noneMsg = `No encontré correos relacionados con "${gmailQuery}", Señor.`;
              setHistory((prev) => [
                ...prev,
                {
                  role: 'jarvis',
                  text: noneMsg,
                  navigateTab: { label: 'Abrir Correo', tab: 'gmail' },
                },
              ]);
              speak(noneMsg);
            } else {
              const latest = found[0];
              const summaryRes = await getGeminiResponse(
                `Resume este correo en español de forma breve, clara y directa (menciona remitente, asunto, fecha y puntos clave):\n\nDe: ${latest.from}\nAsunto: ${latest.subject}\nFecha: ${latest.date}\n\nContenido:\n${latest.body.slice(0, 5000)}`,
                [],
                { model: 'gemini-4-hydrogen', disableTools: true }
              );
              const finalSummary =
                summaryRes.text ||
                `Último correo encontrado: ${latest.subject} (de ${latest.from}).`;
              setHistory((prev) => [
                ...prev,
                {
                  role: 'jarvis',
                  text: finalSummary,
                  modelUsed: summaryRes.modelUsed,
                  navigateTab: { label: 'Ver en Correo', tab: 'gmail' },
                },
              ]);
              speak(finalSummary);
            }
          } catch (gmailErr) {
            if (gmailErr instanceof GmailAuthError) {
              clearAccessToken();
            }
            const errMsg =
              gmailErr instanceof Error
                ? gmailErr.message
                : 'No pude consultar su correo, Señor.';
            setHistory((prev) => [
              ...prev,
              {
                role: 'jarvis',
                text: errMsg,
                navigateTab: { label: 'Conectar Correo', tab: 'gmail' },
              },
            ]);
            speak(errMsg);
          }
        }
      } else if (result.clientAction?.type === 'open_map') {
        const mapQ = result.clientAction.query;
        if (mapQ) setMapInitialQuery(mapQ);
        setHistory((prev) => [
          ...prev,
          {
            role: 'jarvis',
            text: result.text,
            modelUsed: result.modelUsed,
            navigateTab: { label: 'Abrir Mapa Táctico', tab: 'maps' },
          },
        ]);
        speak(result.text);
      } else if (result.text) {
        setHistory((prev) => [
          ...prev,
          {
            role: 'jarvis',
            text: result.text,
            sources: result.sources,
            modelUsed: result.modelUsed,
          },
        ]);
        speak(result.text);
      } else {
        const emptyMsg = 'Señor, no he recibido respuesta del núcleo de procesamiento.';
        setHistory((prev) => [...prev, { role: 'jarvis', text: emptyMsg }]);
      }
    } catch (error) {
      let errorMsg = 'Lo siento Señor, mis servidores de procesamiento han encontrado un error.';

      if (error instanceof GeminiError) {
        switch (error.type) {
          case GeminiErrorType.QUOTA:
            errorMsg = error.message;
            break;
          case GeminiErrorType.NETWORK:
            errorMsg =
              'Señor, hay una falla en mi conexión a la red. Por favor, verifique su enlace de comunicaciones.';
            break;
          case GeminiErrorType.API_KEY:
            errorMsg =
              'Señor, mis credenciales de acceso parecen ser inválidas o faltantes. Por favor, revise la configuración en Settings > Secrets.';
            break;
          case GeminiErrorType.SAFETY:
            errorMsg =
              'Señor, los protocolos de seguridad han bloqueado esa consulta por contenido potencialmente sensible.';
            break;
          default:
            errorMsg = error.message;
        }
      }

      setHistory((prev) => [...prev, { role: 'jarvis', text: errorMsg }]);
      speak(errorMsg);
    } finally {
      setIsProcessing(false);
    }
  };

  processCommandRef.current = processCommand;

  useEffect(() => {
    const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SpeechRecognition) {
      setSpeechSupported(false);
      return;
    }

    const recognition = new SpeechRecognition();
    recognition.continuous = false;
    recognition.interimResults = false;
    recognition.lang = 'es-ES';

    recognition.onresult = (event: any) => {
      const current = event.resultIndex;
      const transcriptText = event.results[current][0].transcript;
      void processCommandRef.current(transcriptText);
    };

    recognition.onend = () => {
      setIsListening(false);
    };

    recognition.onerror = (event: any) => {
      console.error('Speech recognition error:', event.error);
      setIsListening(false);
      if (event.error === 'not-allowed' || event.error === 'service-not-allowed') {
        setHistory((prev) => [
          ...prev,
          {
            role: 'jarvis',
            text: 'Señor, el acceso al micrófono fue denegado. Puede habilitarlo o escribir su orden abajo.',
          },
        ]);
      } else if (event.error === 'audio-capture') {
        setHistory((prev) => [
          ...prev,
          {
            role: 'jarvis',
            text: 'Señor, no detecto ningún micrófono conectado. Puede escribir su orden abajo.',
          },
        ]);
      } else if (event.error === 'network') {
        setHistory((prev) => [
          ...prev,
          {
            role: 'jarvis',
            text: 'Señor, el reconocimiento de voz encontró un problema de red. Puede escribir su orden abajo.',
          },
        ]);
      }
    };

    recognitionRef.current = recognition;

    return () => {
      try {
        recognition.stop();
      } catch {
        // Ignore cleanup errors
      }
    };
  }, []);

  const toggleListening = () => {
    if (!speechSupported || !recognitionRef.current) {
      setHistory((prev) => [
        ...prev,
        {
          role: 'jarvis',
          text: 'Señor, el reconocimiento de voz no está disponible en este navegador. Puede escribir su orden abajo.',
        },
      ]);
      return;
    }

    if (isListening) {
      try {
        recognitionRef.current.stop();
      } catch {
        setIsListening(false);
      }
    } else {
      stopAudio();
      setTranscript('');
      try {
        setIsListening(true);
        recognitionRef.current.start();
      } catch (err) {
        console.error('Failed to start speech recognition:', err);
        setIsListening(false);
      }
    }
  };

  const toggleMute = () => {
    const nextMuted = !isMuted;
    setIsMuted(nextMuted);
    if (audioRef.current) {
      audioRef.current.muted = nextMuted;
    }
    if (nextMuted) {
      stopAudio();
    }
  };

  const handleTextSubmit = (e: FormEvent) => {
    e.preventDefault();
    if (!textInput.trim() || isProcessing) return;
    const cmd = textInput.trim();
    setTextInput('');
    void processCommand(cmd);
  };

  const clearHistory = () => {
    stopAudio();
    setTranscript('');
    setActionLink(null);
    setHistory([
      {
        role: 'jarvis',
        text: 'Memoria de sesión reiniciada, Señor. Estoy a su disposición.',
      },
    ]);
  };

  const handleRoleChange = (roleId: string) => {
    setSelectedRoleId(roleId);
    const found = ROLE_PRESETS.find((r) => r.id === roleId);
    if (found) {
      setSystemInstruction(found.instruction);
    }
  };

  return (
    <div className="min-h-screen bg-[#050505] text-[#42d1f5] font-mono selection:bg-[#42d1f5]/30 flex flex-col overflow-x-hidden">
      <audio ref={audioRef} className="hidden" />

      {/* Case A Demo Key Sticky Quota Banner */}
      {mapsQuotaExceeded && (
        <div className="bg-amber-50 border-b border-amber-200 text-amber-900 px-4 py-2.5 text-xs md:text-sm text-center sticky top-0 z-50 shadow-sm font-sans">
          <span>
            Google Maps Platform quota reached. If you are the app owner, visit{' '}
            <a
              href="https://developers.google.com/maps/ai/ai-studio?utm_campaign=gmp_mcp_codeassist_v1_aistudio#quota_exceeded_errors"
              target="_blank"
              rel="noopener noreferrer"
              className="underline font-semibold text-amber-950 hover:text-amber-800"
            >
              maps developer site
            </a>{' '}
            for instructions to update your account.
          </span>
        </div>
      )}

      {/* Background Grid */}
      <div
        className="fixed inset-0 opacity-10 pointer-events-none"
        style={{
          backgroundImage: 'radial-gradient(#42d1f5 1px, transparent 1px)',
          backgroundSize: '40px 40px',
        }}
      />

      {/* Top HUD Bar */}
      <header className="relative z-20 w-full max-w-5xl mx-auto px-4 pt-5 pb-3 flex flex-wrap items-center justify-between gap-3">
        <div className="hidden sm:flex items-center gap-4 text-[11px] opacity-60">
          <span className="flex items-center gap-1.5">
            <Shield size={13} />
            SISTEMAS: ACTIVOS
          </span>
          <span className="flex items-center gap-1.5">
            <Zap size={13} />
            ENERGÍA: 98%
          </span>
        </div>

        <div className="text-center mx-auto sm:mx-0">
          <h1 className="text-2xl sm:text-3xl font-bold tracking-[0.22em] text-white">
            J.A.R.V.Y.S.
          </h1>
          <p className="text-[9px] uppercase tracking-[0.35em] opacity-50">
            Stark Command Center
          </p>
        </div>

        <div className="hidden sm:flex items-center gap-4 text-[11px] opacity-60">
          <span className="flex items-center gap-1.5">
            <Clock size={13} />
            {currentTime}
          </span>
          <span className="flex items-center gap-1.5">
            <Globe size={13} />
            RED: ESTABLE
          </span>
        </div>
      </header>

      {/* Primary Module Tabs */}
      <nav
        aria-label="Módulos de J.A.R.V.Y.S."
        className="relative z-20 w-full max-w-4xl mx-auto px-4 mb-5"
      >
        <div className="grid grid-cols-2 sm:grid-cols-5 gap-2 bg-[#42d1f5]/5 border border-[#42d1f5]/20 p-1.5 rounded-lg backdrop-blur-md">
          <button
            type="button"
            onClick={() => setActiveTab('core')}
            className={`py-2 px-3 rounded text-xs uppercase tracking-wider flex items-center justify-center gap-2 cursor-pointer transition-colors ${
              activeTab === 'core'
                ? 'bg-[#42d1f5]/20 border border-[#42d1f5] text-white'
                : 'border border-transparent text-[#42d1f5]/70 hover:text-white hover:bg-[#42d1f5]/10'
            }`}
          >
            <Bot size={14} />
            <span>Núcleo & Chat</span>
          </button>

          <button
            type="button"
            onClick={() => setActiveTab('gmail')}
            className={`py-2 px-3 rounded text-xs uppercase tracking-wider flex items-center justify-center gap-2 cursor-pointer transition-colors ${
              activeTab === 'gmail'
                ? 'bg-[#42d1f5]/20 border border-[#42d1f5] text-white'
                : 'border border-transparent text-[#42d1f5]/70 hover:text-white hover:bg-[#42d1f5]/10'
            }`}
          >
            <Mail size={14} />
            <span>Correo</span>
          </button>

          <button
            type="button"
            onClick={() => setActiveTab('maps')}
            className={`py-2 px-3 rounded text-xs uppercase tracking-wider flex items-center justify-center gap-2 cursor-pointer transition-colors ${
              activeTab === 'maps'
                ? 'bg-[#42d1f5]/20 border border-[#42d1f5] text-white'
                : 'border border-transparent text-[#42d1f5]/70 hover:text-white hover:bg-[#42d1f5]/10'
            }`}
          >
            <MapPin size={14} />
            <span>Mapa Táctico</span>
          </button>

          <button
            type="button"
            onClick={() => setActiveTab('image')}
            className={`py-2 px-3 rounded text-xs uppercase tracking-wider flex items-center justify-center gap-2 cursor-pointer transition-colors ${
              activeTab === 'image'
                ? 'bg-[#42d1f5]/20 border border-[#42d1f5] text-white'
                : 'border border-transparent text-[#42d1f5]/70 hover:text-white hover:bg-[#42d1f5]/10'
            }`}
          >
            <ImageIcon size={14} />
            <span>Estudio Imagen</span>
          </button>

          <button
            type="button"
            onClick={() => setActiveTab('video')}
            className={`py-2 px-3 rounded text-xs uppercase tracking-wider flex items-center justify-center gap-2 cursor-pointer transition-colors ${
              activeTab === 'video'
                ? 'bg-[#42d1f5]/20 border border-[#42d1f5] text-white'
                : 'border border-transparent text-[#42d1f5]/70 hover:text-white hover:bg-[#42d1f5]/10'
            }`}
          >
            <Film size={14} />
            <span>Estudio Video</span>
          </button>
        </div>
      </nav>

      {/* Main Content Area */}
      <main className="relative z-10 flex-1 w-full max-w-4xl mx-auto px-4 pb-24">
        {activeTab === 'core' && (
          <div className="flex flex-col items-center space-y-6">
            {/* Voice Core Visualizer */}
            <div className="pt-2 pb-1 flex flex-col items-center">
              <button
                type="button"
                onClick={toggleListening}
                aria-label={isListening ? 'Detener escucha' : 'Activar micrófono'}
                className="relative group cursor-pointer focus:outline-none"
              >
                <motion.div
                  animate={{ rotate: 360 }}
                  transition={{ duration: 20, repeat: Infinity, ease: 'linear' }}
                  className="absolute -inset-6 border border-[#42d1f5]/20 rounded-full pointer-events-none"
                />
                <motion.div
                  animate={{ rotate: -360 }}
                  transition={{ duration: 15, repeat: Infinity, ease: 'linear' }}
                  className="absolute -inset-3 border border-dashed border-[#42d1f5]/40 rounded-full pointer-events-none"
                />

                <div
                  className={`w-32 h-32 sm:w-36 sm:h-36 rounded-full flex items-center justify-center relative bg-black border-2 transition-all duration-500 ${
                    isListening
                      ? 'border-[#42d1f5] shadow-[0_0_50px_rgba(66,209,245,0.4)]'
                      : isProcessing
                      ? 'border-[#42d1f5]/80 shadow-[0_0_30px_rgba(66,209,245,0.25)]'
                      : 'border-[#42d1f5]/30 group-hover:border-[#42d1f5]/70'
                  }`}
                >
                  <AnimatePresence mode="wait">
                    {isListening ? (
                      <motion.div
                        key="listening"
                        initial={{ scale: 0.8, opacity: 0 }}
                        animate={{ scale: 1, opacity: 1 }}
                        exit={{ scale: 0.8, opacity: 0 }}
                        className="flex gap-1"
                      >
                        {[...Array(5)].map((_, i) => (
                          <motion.div
                            key={i}
                            animate={{ height: [8, 32, 8] }}
                            transition={{ duration: 0.5, repeat: Infinity, delay: i * 0.1 }}
                            className="w-1 bg-[#42d1f5] rounded-full"
                          />
                        ))}
                      </motion.div>
                    ) : isProcessing ? (
                      <motion.div
                        key="processing"
                        animate={{ rotate: 360 }}
                        transition={{ duration: 1.2, repeat: Infinity, ease: 'linear' }}
                        className="w-10 h-10 rounded-full border-2 border-[#42d1f5]/20 border-t-[#42d1f5]"
                      />
                    ) : isSpeaking ? (
                      <motion.div
                        key="speaking"
                        animate={{ scale: [1, 1.1, 1] }}
                        transition={{ duration: 0.5, repeat: Infinity }}
                        className="text-[#42d1f5]"
                      >
                        <Volume2 size={36} strokeWidth={1.2} />
                      </motion.div>
                    ) : (
                      <motion.div
                        key="idle"
                        initial={{ opacity: 0 }}
                        animate={{ opacity: 1 }}
                        className="text-[#42d1f5]/60 group-hover:text-[#42d1f5] transition-colors"
                      >
                        <Mic size={36} strokeWidth={1.2} />
                      </motion.div>
                    )}
                  </AnimatePresence>

                  {isListening && (
                    <motion.div
                      animate={{ top: ['0%', '100%', '0%'] }}
                      transition={{ duration: 2, repeat: Infinity }}
                      className="absolute left-0 right-0 h-1 bg-[#42d1f5]/50 blur-sm z-20"
                    />
                  )}
                </div>
              </button>
            </div>

            {/* Chatbot Controls & Multi-turn Console */}
            <div className="w-full space-y-3">
              {/* Model Selector, Google Search Toggle, Role Config */}
              <div className="bg-[#42d1f5]/5 border border-[#42d1f5]/20 rounded-lg p-3 space-y-3">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div className="flex flex-wrap items-center gap-2">
                    <label
                      htmlFor="model-select"
                      className="text-[10px] uppercase tracking-widest opacity-60"
                    >
                      Modelo:
                    </label>
                    <select
                      id="model-select"
                      value={useSearch ? 'gemini-4-hydrogen' : selectedModel}
                      disabled={useSearch}
                      onChange={(e) => setSelectedModel(e.target.value as ChatModelId)}
                      className="bg-black/70 border border-[#42d1f5]/30 rounded px-2.5 py-1.5 text-xs text-white focus:outline-none focus:border-[#42d1f5] disabled:opacity-70"
                    >
                      {MODEL_OPTIONS.map((m) => (
                        <option key={m.id} value={m.id}>
                          {m.label} · {m.hint}
                        </option>
                      ))}
                    </select>
                  </div>

                  <div className="flex flex-wrap items-center gap-2">
                    <button
                      type="button"
                      onClick={() => setUseSearch((prev) => !prev)}
                      aria-pressed={useSearch}
                      className={`px-3 py-1.5 rounded border text-xs flex items-center gap-1.5 cursor-pointer transition-colors ${
                        useSearch
                          ? 'bg-[#42d1f5]/25 border-[#42d1f5] text-white'
                          : 'bg-black/40 border-[#42d1f5]/25 text-[#42d1f5]/80 hover:border-[#42d1f5]/60'
                      }`}
                    >
                      <Search size={12} />
                      <span>Búsqueda Google: {useSearch ? 'ON' : 'OFF'}</span>
                    </button>

                    <button
                      type="button"
                      onClick={() => setShowConfig((prev) => !prev)}
                      className={`px-3 py-1.5 rounded border text-xs flex items-center gap-1.5 cursor-pointer transition-colors ${
                        showConfig
                          ? 'bg-[#42d1f5]/20 border-[#42d1f5] text-white'
                          : 'bg-black/40 border-[#42d1f5]/25 text-[#42d1f5]/80 hover:border-[#42d1f5]/60'
                      }`}
                    >
                      <SlidersHorizontal size={12} />
                      <span>Rol / Instrucción</span>
                    </button>

                    <button
                      type="button"
                      onClick={clearHistory}
                      title="Reiniciar conversación"
                      className="px-2.5 py-1.5 rounded border border-[#42d1f5]/25 bg-black/40 hover:border-[#42d1f5]/60 text-xs flex items-center gap-1 cursor-pointer"
                    >
                      <Trash2 size={12} />
                      <span className="hidden sm:inline">Limpiar</span>
                    </button>
                  </div>
                </div>

                {useSearch && (
                  <p className="text-[11px] text-[#42d1f5]/80">
                    Búsqueda en tiempo real activa con <span className="text-white">gemini-4-hydrogen</span> y fuentes web verificadas.
                  </p>
                )}

                {showConfig && (
                  <div className="pt-2 border-t border-[#42d1f5]/15 space-y-2">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="text-[10px] uppercase tracking-wider opacity-60">
                        Rol predefinido:
                      </span>
                      <select
                        value={selectedRoleId}
                        onChange={(e) => handleRoleChange(e.target.value)}
                        className="bg-black/70 border border-[#42d1f5]/25 rounded px-2.5 py-1 text-xs text-white focus:outline-none focus:border-[#42d1f5]"
                      >
                        {ROLE_PRESETS.map((r) => (
                          <option key={r.id} value={r.id}>
                            {r.label}
                          </option>
                        ))}
                        <option value="custom">Personalizado</option>
                      </select>
                    </div>
                    <textarea
                      rows={2}
                      value={systemInstruction}
                      onChange={(e) => {
                        setSelectedRoleId('custom');
                        setSystemInstruction(e.target.value);
                      }}
                      placeholder="Instrucciones del sistema para el asistente..."
                      className="w-full bg-black/60 border border-[#42d1f5]/25 rounded px-3 py-2 text-xs text-white placeholder-[#42d1f5]/40 focus:outline-none focus:border-[#42d1f5]"
                    />
                  </div>
                )}
              </div>

              {/* Scrollable Multi-Turn Conversation Thread */}
              <div className="bg-[#42d1f5]/5 border border-[#42d1f5]/20 rounded-lg p-4 backdrop-blur-md">
                <div className="flex items-center justify-between mb-3 text-[10px] uppercase tracking-widest opacity-60">
                  <div className="flex items-center gap-2">
                    <Terminal size={12} />
                    <span>Hilo de Conversación ({history.length})</span>
                  </div>
                  <span>ID: {sessionId}</span>
                </div>

                <div
                  ref={chatScrollRef}
                  className="max-h-72 overflow-y-auto space-y-3 pr-1"
                >
                  {history.map((entry, idx) => (
                    <div
                      key={idx}
                      className={`rounded-lg p-3 text-sm leading-relaxed ${
                        entry.role === 'user'
                          ? 'bg-white/5 border border-white/10 text-white ml-8'
                          : 'bg-black/45 border border-[#42d1f5]/20 text-[#42d1f5] mr-4'
                      }`}
                    >
                      <div className="flex items-center justify-between text-[10px] uppercase tracking-wider opacity-55 mb-1">
                        <span>{entry.role === 'user' ? 'Señor' : 'J.A.R.V.Y.S.'}</span>
                        {entry.modelUsed && <span>{entry.modelUsed}</span>}
                      </div>
                      <p className="whitespace-pre-wrap">{entry.text}</p>

                      {entry.imageUrl && (
                        <div className="mt-3 space-y-2">
                          <div className="rounded-lg overflow-hidden border border-[#42d1f5]/35 bg-black flex justify-center">
                            <img
                              src={entry.imageUrl}
                              alt="Imagen generada por J.A.R.V.Y.S."
                              className="max-h-72 object-contain"
                            />
                          </div>
                          <div className="flex flex-wrap gap-2">
                            <a
                              href={entry.imageUrl}
                              download="jarvis_imagen.png"
                              className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded border border-[#42d1f5]/35 text-[11px] hover:bg-[#42d1f5]/15"
                            >
                              <Download size={12} />
                              <span>Descargar</span>
                            </a>
                          </div>
                        </div>
                      )}

                      {entry.videoInteractionId && !entry.videoUrl && (
                        <div className="mt-2.5 flex items-center gap-2 text-xs text-[#42d1f5]">
                          <Loader2 size={14} className="animate-spin" />
                          <span>Renderizando video en el núcleo Stark...</span>
                        </div>
                      )}

                      {entry.videoUrl && (
                        <div className="mt-3 space-y-2">
                          <video
                            src={entry.videoUrl}
                            controls
                            autoPlay
                            loop
                            className="w-full max-h-72 rounded-lg border border-[#42d1f5]/35 bg-black"
                          />
                          <a
                            href={entry.videoUrl}
                            download="jarvis_video.mp4"
                            className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded border border-[#42d1f5]/35 text-[11px] hover:bg-[#42d1f5]/15"
                          >
                            <Download size={12} />
                            <span>Descargar MP4</span>
                          </a>
                        </div>
                      )}

                      {entry.navigateTab && (
                        <div className="mt-2.5">
                          <button
                            type="button"
                            onClick={() => setActiveTab(entry.navigateTab!.tab)}
                            className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded border border-[#42d1f5]/40 bg-[#42d1f5]/15 hover:bg-[#42d1f5]/25 text-xs text-white cursor-pointer transition-colors"
                          >
                            <span>{entry.navigateTab.label}</span>
                          </button>
                        </div>
                      )}

                      {entry.sources && entry.sources.length > 0 && (
                        <div className="mt-2.5 pt-2 border-t border-[#42d1f5]/15 space-y-1">
                          <span className="text-[10px] uppercase tracking-wider opacity-60 block">
                            Fuentes de Google Search:
                          </span>
                          <div className="flex flex-wrap gap-1.5">
                            {entry.sources.map((src, sIdx) => (
                              <a
                                key={sIdx}
                                href={src.uri}
                                target="_blank"
                                rel="noopener noreferrer"
                                className="inline-flex items-center gap-1 px-2 py-1 rounded border border-[#42d1f5]/30 bg-[#42d1f5]/10 text-[11px] text-white/90 hover:bg-[#42d1f5]/20 transition-colors"
                              >
                                <span className="max-w-[200px] truncate">{src.title}</span>
                                <ExternalLink size={10} />
                              </a>
                            ))}
                          </div>
                        </div>
                      )}
                    </div>
                  ))}

                  {isProcessing && (
                    <div className="rounded-lg p-3 text-xs bg-black/40 border border-[#42d1f5]/20 text-[#42d1f5]/80 mr-4 animate-pulse">
                      Procesando solicitud en el núcleo Stark...
                    </div>
                  )}
                </div>

                {actionLink && (
                  <div className="mt-3 pt-3 border-t border-[#42d1f5]/15">
                    <a
                      href={actionLink.url}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="inline-flex items-center gap-2 px-4 py-2 text-xs uppercase tracking-wider border border-[#42d1f5]/40 rounded hover:bg-[#42d1f5]/15 transition-colors"
                    >
                      <span>{actionLink.label}</span>
                      <ExternalLink size={12} />
                    </a>
                  </div>
                )}
              </div>

              {transcript && (
                <div className="flex justify-end">
                  <div className="bg-white/5 border border-white/10 px-4 py-1.5 rounded text-white/60 text-xs italic">
                    Última entrada: &ldquo;{transcript}&rdquo;
                  </div>
                </div>
              )}

              {/* Direct Text Command Input */}
              <form onSubmit={handleTextSubmit} className="flex gap-2">
                <input
                  type="text"
                  value={textInput}
                  onChange={(e) => setTextInput(e.target.value)}
                  placeholder="Escriba una consulta o comando para J.A.R.V.Y.S., Señor..."
                  disabled={isProcessing}
                  className="flex-1 bg-[#42d1f5]/5 border border-[#42d1f5]/25 rounded-lg px-4 py-3 text-sm text-white placeholder-[#42d1f5]/40 focus:outline-none focus:border-[#42d1f5] transition-colors disabled:opacity-50"
                />
                <button
                  type="submit"
                  disabled={!textInput.trim() || isProcessing}
                  aria-label="Enviar comando"
                  className="px-4 py-3 rounded-lg border border-[#42d1f5]/40 bg-[#42d1f5]/10 hover:bg-[#42d1f5]/25 disabled:opacity-30 disabled:cursor-not-allowed transition-colors cursor-pointer flex items-center justify-center"
                >
                  <Send size={16} />
                </button>
              </form>
            </div>
          </div>
        )}

        {activeTab === 'gmail' && <GmailPanel />}

        {activeTab === 'maps' && <MapsPanel apiKey={mapsApiKey} initialQuery={mapInitialQuery} />}

        {activeTab === 'image' && (
          <MediaStudioPanel
            initialTab="image"
            sharedImageUrl={sharedImageUrl}
            onImageGenerated={setSharedImageUrl}
          />
        )}

        {activeTab === 'video' && (
          <MediaStudioPanel
            initialTab="video"
            sharedImageUrl={sharedImageUrl}
            onImageGenerated={setSharedImageUrl}
          />
        )}
      </main>

      {/* Footer Status & Voice Controls */}
      <footer className="relative z-10 w-full max-w-4xl mx-auto px-4 pb-6 flex justify-between items-center text-[10px] uppercase tracking-[0.2em] opacity-30">
        <span>Stark Industries v9.0</span>
        <span>Protocolo: Multimodal Integrado</span>
        <span>ID: {sessionId}</span>
      </footer>

      {activeTab === 'core' && (
        <div className="fixed bottom-5 right-5 flex gap-3 z-30">
          <button
            type="button"
            onClick={toggleListening}
            aria-label={isListening ? 'Detener micrófono' : 'Activar micrófono'}
            title={isListening ? 'Detener escucha' : 'Hablar con J.A.R.V.Y.S.'}
            className={`p-3.5 rounded-full border transition-all duration-300 cursor-pointer shadow-lg ${
              isListening
                ? 'bg-[#42d1f5] text-black border-[#42d1f5]'
                : 'bg-black/90 border-[#42d1f5]/40 hover:border-[#42d1f5]'
            }`}
          >
            {isListening ? <MicOff size={18} /> : <Mic size={18} />}
          </button>
          <button
            type="button"
            onClick={toggleMute}
            aria-label={isMuted ? 'Activar audio' : 'Silenciar audio'}
            title={isMuted ? 'Activar voz' : 'Silenciar voz'}
            className={`p-3.5 rounded-full border transition-all cursor-pointer shadow-lg ${
              isMuted
                ? 'bg-[#42d1f5]/20 border-[#42d1f5] text-white'
                : 'bg-black/90 border-[#42d1f5]/40 hover:border-[#42d1f5]'
            }`}
          >
            {isMuted ? <VolumeX size={18} /> : <Volume2 size={18} />}
          </button>
        </div>
      )}
    </div>
  );
}
