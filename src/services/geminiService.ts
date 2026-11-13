export enum GeminiErrorType {
  NETWORK = 'NETWORK',
  QUOTA = 'QUOTA',
  API_KEY = 'API_KEY',
  SAFETY = 'SAFETY',
  UNKNOWN = 'UNKNOWN',
}

export class GeminiError extends Error {
  constructor(public type: GeminiErrorType, message: string) {
    super(message);
    this.name = 'GeminiError';
  }
}

export type ChatModelId =
  | 'gemini-4-hydrogen'
  | 'gemini-3.1-flash-lite'
  | 'gemini-4-argon'
  | 'gemini-4-carbon';

export interface SearchSource {
  title: string;
  uri: string;
}

export interface ClientAction {
  type: 'gmail_search' | 'open_map';
  query: string;
}

export interface ChatTurn {
  role: 'user' | 'jarvis';
  text: string;
  sources?: SearchSource[];
  modelUsed?: string;
  imageUrl?: string;
  videoUrl?: string;
  videoInteractionId?: string;
  navigateTab?: { label: string; tab: 'gmail' | 'maps' | 'image' | 'video' };
}

export interface ChatResponseData {
  text: string;
  sources: SearchSource[];
  modelUsed: string;
  imageUrl?: string;
  videoInteractionId?: string;
  videoUrl?: string;
  clientAction?: ClientAction;
}

export interface ChatOptions {
  model?: ChatModelId;
  systemInstruction?: string;
  useSearch?: boolean;
  disableTools?: boolean;
}

export interface ImageGenerationRequest {
  prompt: string;
  imageBase64?: string;
  imageMimeType?: string;
  aspectRatio?: '1:1' | '3:4' | '4:3' | '9:16' | '16:9' | '1:4' | '4:1';
  imageSize?: '1K' | '2K' | '4K';
  useSearch?: boolean;
}

export interface ImageGenerationResult {
  imageUrl: string;
  text: string;
  sources: SearchSource[];
}

export interface VideoGenerationRequest {
  prompt: string;
  imageBase64?: string;
  imageMimeType?: string;
  aspectRatio: '16:9' | '9:16';
  duration?: '5s' | '8s' | '10s';
  resolution?: '720p' | '1080p';
}

export interface VideoGenerationStatus {
  interactionId: string;
  status: string;
  videoUrl?: string;
}

function parseErrorType(rawType?: string): GeminiErrorType {
  switch (rawType) {
    case GeminiErrorType.NETWORK:
      return GeminiErrorType.NETWORK;
    case GeminiErrorType.QUOTA:
      return GeminiErrorType.QUOTA;
    case GeminiErrorType.API_KEY:
      return GeminiErrorType.API_KEY;
    case GeminiErrorType.SAFETY:
      return GeminiErrorType.SAFETY;
    default:
      return GeminiErrorType.UNKNOWN;
  }
}

async function parseJsonOrThrow<T>(response: Response): Promise<T> {
  let data: Record<string, unknown> = {};
  try {
    data = (await response.json()) as Record<string, unknown>;
  } catch {
    // Non-JSON response
  }

  if (!response.ok) {
    throw new GeminiError(
      parseErrorType(typeof data.errorType === 'string' ? data.errorType : undefined),
      typeof data.message === 'string'
        ? data.message
        : 'Señor, ha ocurrido un error imprevisto en mis sistemas centrales.'
    );
  }

  return data as T;
}

export async function getGeminiResponse(
  prompt: string,
  history: ChatTurn[] = [],
  options: ChatOptions = {}
): Promise<ChatResponseData> {
  let response: Response;
  try {
    response = await fetch('/api/gemini/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        message: prompt,
        history: history.map((h) => ({ role: h.role, text: h.text })),
        model: options.model,
        systemInstruction: options.systemInstruction,
        useSearch: options.useSearch,
        disableTools: options.disableTools,
      }),
    });
  } catch (error) {
    console.error('Network error calling /api/gemini/chat:', error);
    throw new GeminiError(
      GeminiErrorType.NETWORK,
      'Señor, parece que hay una interrupción en la red de comunicaciones.'
    );
  }

  const data = await parseJsonOrThrow<{
    text?: string;
    sources?: SearchSource[];
    modelUsed?: string;
    imageUrl?: string;
    videoInteractionId?: string;
    videoUrl?: string;
    clientAction?: ClientAction;
  }>(response);

  return {
    text: data.text || '',
    sources: Array.isArray(data.sources) ? data.sources : [],
    modelUsed: data.modelUsed || options.model || 'gemini-4-hydrogen',
    imageUrl: data.imageUrl,
    videoInteractionId: data.videoInteractionId,
    videoUrl: data.videoUrl,
    clientAction: data.clientAction,
  };
}

export async function getGeminiTTS(text: string): Promise<string | null> {
  try {
    const response = await fetch('/api/gemini/tts', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text }),
    });

    if (!response.ok) {
      console.error('Error generating TTS from server:', response.status);
      return null;
    }

    const audioBlob = await response.blob();
    if (!audioBlob || audioBlob.size === 0) {
      return null;
    }

    return URL.createObjectURL(audioBlob);
  } catch (error) {
    console.error('Error generating TTS:', error);
    return null;
  }
}

export async function generateOrEditImage(
  request: ImageGenerationRequest
): Promise<ImageGenerationResult> {
  let response: Response;
  try {
    response = await fetch('/api/gemini/image', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(request),
    });
  } catch (error) {
    console.error('Network error calling /api/gemini/image:', error);
    throw new GeminiError(
      GeminiErrorType.NETWORK,
      'Señor, no se pudo conectar con el módulo de procesamiento visual.'
    );
  }

  return parseJsonOrThrow<ImageGenerationResult>(response);
}

export async function startVideoGeneration(
  request: VideoGenerationRequest
): Promise<VideoGenerationStatus> {
  let response: Response;
  try {
    response = await fetch('/api/gemini/video', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(request),
    });
  } catch (error) {
    console.error('Network error calling /api/gemini/video:', error);
    throw new GeminiError(
      GeminiErrorType.NETWORK,
      'Señor, no se pudo conectar con el módulo de síntesis de video.'
    );
  }

  return parseJsonOrThrow<VideoGenerationStatus>(response);
}

export async function pollVideoGeneration(
  interactionId: string
): Promise<VideoGenerationStatus> {
  let response: Response;
  try {
    response = await fetch(`/api/gemini/video/${encodeURIComponent(interactionId)}`);
  } catch (error) {
    console.error('Network error polling /api/gemini/video:', error);
    throw new GeminiError(
      GeminiErrorType.NETWORK,
      'Señor, se interrumpió la consulta del progreso de video.'
    );
  }

  return parseJsonOrThrow<VideoGenerationStatus>(response);
}

export async function fetchPublicConfig(): Promise<{ mapsApiKey: string }> {
  try {
    const res = await fetch('/api/config');
    if (!res.ok) return { mapsApiKey: '' };
    return (await res.json()) as { mapsApiKey: string };
  } catch {
    return { mapsApiKey: '' };
  }
}
