import "dotenv/config";
import express from "express";
import type { Request, Response } from "express";
import path from "path";
import { fileURLToPath } from "url";
import {
  GoogleGenAI,
  Modality,
  Type,
  type Content,
  type FunctionDeclaration,
} from "@google/genai";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const DEFAULT_JARVIS_INSTRUCTION =
  "Eres J.A.R.V.Y.S., el asistente de inteligencia artificial personal de Tony Stark. Eres servicial, eficiente, con un tono calmado y profesional, llamando al usuario 'Señor'. Tus respuestas deben ser MUY cortas, directas y elegantes. Evita explicaciones largas a menos que se te pida. Mantén el estilo sofisticado de las películas de Iron Man. Responde siempre en español. REGLA CRÍTICA: Nunca digas que ya creaste una imagen, generaste un video o leíste un correo a menos que ejecutes la herramienta correspondiente (`generate_image`, `generate_video`, `search_gmail`, `open_map`).";

const ALLOWED_CHAT_MODELS = new Set([
  "gemini-4-hydrogen",
  "gemini-3.1-flash-lite",
  "gemini-4-argon",
  "gemini-4-carbon",
]);

const PAID_ONLY_MODELS = new Set([
  "gemini-4-argon",
  "gemini-4-carbon",
  "gemini-nano-banana-2.1",
  "gemini-omni-1.2-flash",
]);

let aiClient: GoogleGenAI | null = null;
let v1BetaAiClient: GoogleGenAI | null = null;

function getAiClient(apiVersion?: string): GoogleGenAI {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    const err = new Error("API key not configured") as Error & { status?: number };
    err.status = 400;
    throw err;
  }
  if (apiVersion === "v1beta") {
    if (!v1BetaAiClient) {
      v1BetaAiClient = new GoogleGenAI({
        apiKey,
        apiVersion: "v1beta",
        httpOptions: {
          headers: {
            "User-Agent": "aistudio-build",
          },
        },
      });
    }
    return v1BetaAiClient;
  }
  if (!aiClient) {
    aiClient = new GoogleGenAI({
      apiKey,
      httpOptions: {
        headers: {
          "User-Agent": "aistudio-build",
        },
      },
    });
  }
  return aiClient;
}

interface ChatHistoryEntry {
  role: "user" | "jarvis";
  text: string;
}

function normalizeHistory(rawHistory: unknown): Content[] {
  if (!Array.isArray(rawHistory)) return [];

  const normalized: Content[] = [];
  for (const item of rawHistory) {
    if (
      !item ||
      typeof item !== "object" ||
      typeof (item as ChatHistoryEntry).text !== "string" ||
      !(item as ChatHistoryEntry).text.trim()
    ) {
      continue;
    }

    const role = (item as ChatHistoryEntry).role === "jarvis" ? "model" : "user";
    const text = (item as ChatHistoryEntry).text.trim();

    if (normalized.length === 0 && role !== "user") {
      continue;
    }

    const last = normalized[normalized.length - 1];
    if (last && last.role === role) {
      last.parts = [{ text: `${last.parts?.[0]?.text ?? ""}\n${text}` }];
    } else {
      normalized.push({ role, parts: [{ text }] });
    }
  }

  if (normalized.length > 0 && normalized[normalized.length - 1].role === "user") {
    normalized.pop();
  }

  return normalized;
}

interface ClassifiedError {
  status: number;
  errorType: "NETWORK" | "QUOTA" | "API_KEY" | "SAFETY" | "UNKNOWN";
  message: string;
}

function classifyGeminiError(error: unknown, modelName?: string): ClassifiedError {
  const errObj = error as { message?: string; status?: number; code?: number };
  const message = errObj?.message || "";
  const lower = message.toLowerCase();
  const status = errObj?.status || errObj?.code;
  const isPaidModel = modelName ? PAID_ONLY_MODELS.has(modelName) : false;

  if (
    lower.includes("api key not valid") ||
    lower.includes("api_key_invalid") ||
    lower.includes("api key not configured") ||
    status === 401 ||
    status === 403 ||
    lower.includes("permission_denied")
  ) {
    return {
      status: 400,
      errorType: "API_KEY",
      message:
        "La clave de API no es válida, no está configurada o no tiene permisos para este modelo, Señor. Verifique su clave en el panel Settings > Secrets.",
    };
  }

  if (
    lower.includes("quota exceeded") ||
    lower.includes("resource_exhausted") ||
    lower.includes("429") ||
    status === 429
  ) {
    return {
      status: 429,
      errorType: "QUOTA",
      message: isPaidModel
        ? `Señor, el modelo ${modelName} requiere una clave de API con facturación habilitada o se ha alcanzado la cuota. Puede configurar una clave de pago en Settings > Secrets.`
        : "Señor, hemos excedido la cuota de peticiones permitida. Por favor intente nuevamente en unos momentos o configure una clave de pago en Settings > Secrets.",
    };
  }

  if (lower.includes("safety") || lower.includes("blocked")) {
    return {
      status: 400,
      errorType: "SAFETY",
      message: "Señor, los protocolos de seguridad han bloqueado esta respuesta.",
    };
  }

  if (
    lower.includes("fetch") ||
    lower.includes("network") ||
    lower.includes("econnreset") ||
    lower.includes("etimedout") ||
    lower.includes("enotfound")
  ) {
    return {
      status: 502,
      errorType: "NETWORK",
      message: "Señor, parece que hay una interrupción en la red de comunicaciones.",
    };
  }

  return {
    status: status && status >= 400 && status < 600 ? status : 500,
    errorType: "UNKNOWN",
    message: "Señor, ha ocurrido un error imprevisto en mis sistemas centrales.",
  };
}

function isTransientError(error: unknown): boolean {
  const errObj = error as { message?: string; status?: number; code?: number };
  const status = errObj?.status || errObj?.code;
  const lower = (errObj?.message || "").toLowerCase();
  return (
    status === 429 ||
    status === 500 ||
    status === 502 ||
    status === 503 ||
    status === 504 ||
    lower.includes("econnreset") ||
    lower.includes("etimedout") ||
    lower.includes("unavailable")
  );
}

async function withRetry<T>(fn: () => Promise<T>, maxAttempts = 2): Promise<T> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;
      if (attempt < maxAttempts && isTransientError(error)) {
        const errObj = error as { status?: number; code?: number };
        const delayMs = (errObj?.status || errObj?.code) === 429 ? 1000 : 400 * attempt;
        await new Promise((resolve) => setTimeout(resolve, delayMs));
        continue;
      }
      throw error;
    }
  }
  throw lastError;
}

function ensureWavBuffer(rawBuffer: Buffer, sampleRate = 24000): Buffer {
  if (
    rawBuffer.length >= 12 &&
    rawBuffer.subarray(0, 4).toString("ascii") === "RIFF" &&
    rawBuffer.subarray(8, 12).toString("ascii") === "WAVE"
  ) {
    return rawBuffer;
  }

  const header = Buffer.alloc(44);
  const dataLength = rawBuffer.length;
  header.write("RIFF", 0, "ascii");
  header.writeUInt32LE(36 + dataLength, 4);
  header.write("WAVE", 8, "ascii");
  header.write("fmt ", 12, "ascii");
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write("data", 36, "ascii");
  header.writeUInt32LE(dataLength, 40);

  return Buffer.concat([header, rawBuffer]);
}

interface SearchSource {
  title: string;
  uri: string;
}

function extractGroundingSources(response: {
  candidates?: Array<{
    groundingMetadata?: {
      groundingChunks?: Array<{
        web?: { uri?: string; title?: string };
      }>;
    };
  }>;
}): SearchSource[] {
  const chunks = response.candidates?.[0]?.groundingMetadata?.groundingChunks ?? [];
  const seen = new Set<string>();
  const sources: SearchSource[] = [];

  for (const chunk of chunks) {
    const uri = chunk?.web?.uri;
    if (uri && !seen.has(uri)) {
      seen.add(uri);
      sources.push({
        uri,
        title: chunk.web?.title || uri,
      });
    }
  }
  return sources;
}

const JARVIS_TOOLS: FunctionDeclaration[] = [
  {
    name: "generate_image",
    description:
      "Genera una imagen real a partir de un prompt cuando el usuario pida crear, dibujar, diseñar o generar una imagen, foto o ilustración.",
    parameters: {
      type: Type.OBJECT,
      properties: {
        prompt: {
          type: Type.STRING,
          description:
            "Descripción visual detallada en inglés o español de la imagen a generar.",
        },
        aspectRatio: {
          type: Type.STRING,
          description: "Relación de aspecto opcional: 1:1, 16:9, 9:16, 4:3 o 3:4.",
        },
      },
      required: ["prompt"],
    },
  },
  {
    name: "generate_video",
    description:
      "Genera un video real desde texto cuando el usuario pida crear, animar o generar un video.",
    parameters: {
      type: Type.OBJECT,
      properties: {
        prompt: {
          type: Type.STRING,
          description: "Descripción de la escena de video a generar.",
        },
        aspectRatio: {
          type: Type.STRING,
          description: "Relación de aspecto opcional: 16:9 o 9:16.",
        },
      },
      required: ["prompt"],
    },
  },
  {
    name: "search_gmail",
    description:
      "Busca y resume correos electrónicos en la bandeja de Gmail del usuario cuando pida revisar, buscar o resumir un correo o email.",
    parameters: {
      type: Type.OBJECT,
      properties: {
        query: {
          type: Type.STRING,
          description: "Término de búsqueda para Gmail, por ejemplo 'ICE México'.",
        },
      },
      required: ["query"],
    },
  },
  {
    name: "open_map",
    description:
      "Abre el Mapa Táctico de Google Maps para buscar un lugar, dirección o ruta.",
    parameters: {
      type: Type.OBJECT,
      properties: {
        query: {
          type: Type.STRING,
          description: "Nombre del lugar o dirección a buscar en el mapa.",
        },
      },
      required: ["query"],
    },
  },
];

async function generateImageInternal(params: {
  prompt: string;
  imageBase64?: string;
  imageMimeType?: string;
  aspectRatio?: string;
  imageSize?: string;
  useSearch?: boolean;
}) {
  const validRatios = new Set(["1:1", "3:4", "4:3", "9:16", "16:9", "1:4", "4:1"]);
  const validSizes = new Set(["1K", "2K", "4K"]);
  const safeRatio =
    params.aspectRatio && validRatios.has(params.aspectRatio)
      ? params.aspectRatio
      : "1:1";
  const safeSize =
    params.imageSize && validSizes.has(params.imageSize) ? params.imageSize : "1K";

  const parts: Array<
    { text: string } | { inlineData: { data: string; mimeType: string } }
  > = [];

  if (params.imageBase64 && params.imageBase64.trim()) {
    parts.push({
      inlineData: {
        data: params.imageBase64.trim(),
        mimeType:
          params.imageMimeType && params.imageMimeType.trim()
            ? params.imageMimeType.trim()
            : "image/png",
      },
    });
  }

  parts.push({ text: params.prompt.trim() });

  const ai = getAiClient("v1beta");
  const enableSearch = Boolean(params.useSearch);

  const response = await withRetry(async () => {
    return ai.models.generateContent({
      model: "gemini-nano-banana-2.1",
      contents: { parts },
      config: {
        imageConfig: {
          aspectRatio: safeRatio,
          imageSize: safeSize,
        },
        ...(enableSearch
          ? {
              tools: [
                {
                  googleSearch: {
                    searchTypes: {
                      webSearch: {},
                      imageSearch: {},
                    },
                  },
                },
              ],
            }
          : {}),
      },
    });
  });

  let imageUrl: string | null = null;
  let textOutput = "";

  for (const part of response.candidates?.[0]?.content?.parts ?? []) {
    if (part.inlineData?.data && !imageUrl) {
      const mime = part.inlineData.mimeType || "image/png";
      imageUrl = `data:${mime};base64,${part.inlineData.data}`;
    } else if (part.text) {
      textOutput += (textOutput ? "\n" : "") + part.text;
    }
  }

  return {
    imageUrl,
    text: textOutput,
    sources: enableSearch ? extractGroundingSources(response) : [],
  };
}

async function startServer() {
  const app = express();
  const PORT = Number(process.env.PORT) || 3000;

  app.use(express.json({ limit: "25mb" }));

  // Public client configuration (Maps JS API key injected at runtime)
  app.get("/api/config", (_req: Request, res: Response) => {
    const mapsApiKey =
      process.env.VITE_GOOGLE_MAPS_API_KEY ||
      process.env.GOOGLE_MAPS_API_KEY ||
      "";
    res.json({ mapsApiKey });
  });

  // Multi-turn Gemini chat with model selector, tools & optional Google Search Grounding
  app.post("/api/gemini/chat", async (req: Request, res: Response) => {
    let selectedModel = "gemini-4-hydrogen";
    try {
      const { message, history, model, systemInstruction, useSearch, disableTools } =
        req.body as {
          message?: unknown;
          history?: unknown;
          model?: unknown;
          systemInstruction?: unknown;
          useSearch?: unknown;
          disableTools?: unknown;
        };

      if (typeof message !== "string" || !message.trim()) {
        res.status(400).json({
          errorType: "UNKNOWN",
          message: "Señor, no he recibido ningún mensaje para procesar.",
        });
        return;
      }

      if (typeof model === "string" && ALLOWED_CHAT_MODELS.has(model)) {
        selectedModel = model;
      }

      const enableSearch = Boolean(useSearch);
      const allowTools = !Boolean(disableTools);
      // Use gemini-4-hydrogen when Google Search grounding is enabled
      const effectiveModel = enableSearch ? "gemini-4-hydrogen" : selectedModel;
      selectedModel = effectiveModel;

      const effectiveInstruction =
        typeof systemInstruction === "string" && systemInstruction.trim()
          ? systemInstruction.trim()
          : DEFAULT_JARVIS_INSTRUCTION;

      const ai = getAiClient(enableSearch ? "v1beta" : undefined);
      const formattedHistory = normalizeHistory(history);

      const tools: Array<Record<string, unknown>> = [];
      if (enableSearch) {
        tools.push({ googleSearch: {} });
      }
      if (allowTools) {
        tools.push({ functionDeclarations: JARVIS_TOOLS });
      }

      const response = await withRetry(async () => {
        const chat = ai.chats.create({
          model: effectiveModel,
          config: {
            systemInstruction: effectiveInstruction,
            ...(tools.length > 0 ? { tools } : {}),
            ...(enableSearch && allowTools
              ? { toolConfig: { includeServerSideToolInvocations: true } }
              : {}),
          },
          history: formattedHistory,
        });

        return chat.sendMessage({
          message: message.trim(),
        });
      });

      const functionCalls = response.functionCalls;
      if (functionCalls && functionCalls.length > 0) {
        const call = functionCalls[0];
        const args = (call.args || {}) as Record<string, unknown>;

        if (call.name === "generate_image") {
          const imgPrompt =
            typeof args.prompt === "string" && args.prompt.trim()
              ? args.prompt.trim()
              : message.trim();
          const aspectRatio =
            typeof args.aspectRatio === "string" ? args.aspectRatio : "1:1";

          try {
            selectedModel = "gemini-nano-banana-2.1";
            const imgResult = await generateImageInternal({
              prompt: imgPrompt,
              aspectRatio,
            });

            if (!imgResult.imageUrl) {
              res.status(502).json({
                errorType: "UNKNOWN",
                message:
                  imgResult.text ||
                  "Señor, no pude completar la generación de esa imagen. Intente describirla de otra forma.",
              });
              return;
            }

            res.json({
              text: "Imagen generada, Señor. Puede verla aquí abajo y en Estudio Imagen.",
              imageUrl: imgResult.imageUrl,
              sources: imgResult.sources,
              modelUsed: "gemini-nano-banana-2.1",
            });
            return;
          } catch (imgErr) {
            const classified = classifyGeminiError(imgErr, "gemini-nano-banana-2.1");
            res.status(classified.status).json({
              errorType: classified.errorType,
              message: classified.message,
            });
            return;
          }
        }

        if (call.name === "generate_video") {
          const vidPrompt =
            typeof args.prompt === "string" && args.prompt.trim()
              ? args.prompt.trim()
              : message.trim();
          const aspectRatio = args.aspectRatio === "9:16" ? "9:16" : "16:9";

          try {
            selectedModel = "gemini-omni-1.2-flash";
            const vidAi = getAiClient();
            const interaction = await vidAi.interactions.create(
              {
                model: "gemini-omni-1.2-flash",
                input: vidPrompt,
                background: true,
                store: true,
                response_format: {
                  type: "video",
                  aspect_ratio: aspectRatio,
                  duration: "5s",
                  resolution: "720p",
                },
              },
              { timeout: 60000 }
            );

            let videoUrl: string | undefined;
            if (interaction.status === "completed" && interaction.output_video) {
              if (interaction.output_video.data) {
                const mime = interaction.output_video.mime_type || "video/mp4";
                videoUrl = `data:${mime};base64,${interaction.output_video.data}`;
              } else if (interaction.output_video.uri) {
                videoUrl = interaction.output_video.uri;
              }
            }

            res.json({
              text: videoUrl
                ? "Señor, su video ya está listo."
                : "Señor, he iniciado la síntesis de su video. Aparecerá aquí en unos momentos.",
              videoInteractionId: interaction.id,
              videoUrl,
              sources: [],
              modelUsed: "gemini-omni-1.2-flash",
            });
            return;
          } catch (vidErr) {
            const classified = classifyGeminiError(vidErr, "gemini-omni-1.2-flash");
            res.status(classified.status).json({
              errorType: classified.errorType,
              message: classified.message,
            });
            return;
          }
        }

        if (call.name === "search_gmail") {
          const gmailQuery =
            typeof args.query === "string" && args.query.trim()
              ? args.query.trim()
              : "Ice mexico";
          res.json({
            text: `Consultando su bandeja de Gmail para "${gmailQuery}", Señor...`,
            clientAction: { type: "gmail_search", query: gmailQuery },
            sources: [],
            modelUsed: effectiveModel,
          });
          return;
        }

        if (call.name === "open_map") {
          const mapQuery =
            typeof args.query === "string" && args.query.trim()
              ? args.query.trim()
              : "";
          res.json({
            text: mapQuery
              ? `Abriendo el Mapa Táctico para ubicar "${mapQuery}", Señor.`
              : "Abriendo el Mapa Táctico, Señor.",
            clientAction: { type: "open_map", query: mapQuery },
            sources: [],
            modelUsed: effectiveModel,
          });
          return;
        }
      }

      const text = response.text || "";
      const sources = enableSearch ? extractGroundingSources(response) : [];
      res.json({ text, sources, modelUsed: effectiveModel });
    } catch (error) {
      console.error("Gemini Chat API Error:", error);
      const classified = classifyGeminiError(error, selectedModel);
      res.status(classified.status).json({
        errorType: classified.errorType,
        message: classified.message,
      });
    }
  });

  // Gemini Text-to-Speech (Zephyr calm voice)
  app.post("/api/gemini/tts", async (req: Request, res: Response) => {
    try {
      const { text } = req.body as { text?: unknown };
      if (typeof text !== "string" || !text.trim()) {
        res.status(400).json({
          errorType: "UNKNOWN",
          message: "Texto vacío para síntesis de voz.",
        });
        return;
      }

      const ai = getAiClient("v1beta");
      const response = await withRetry(async () => {
        return ai.models.generateContent({
          model: "gemini-3.8-flash-lite-tts",
          contents: [
            {
              role: "user",
              parts: [
                {
                  text: text.trim(),
                  speechMetadata: {
                    style: "Calm, sophisticated, concise AI assistant speaking Spanish",
                  },
                },
              ],
            },
          ],
          config: {
            responseModalities: [Modality.AUDIO],
            speechConfig: {
              voiceConfig: {
                prebuiltVoiceConfig: { voiceName: "Zephyr" },
              },
            },
          },
        });
      });

      const base64Audio =
        response.candidates?.[0]?.content?.parts?.[0]?.inlineData?.data;

      if (!base64Audio) {
        res.status(502).json({
          errorType: "UNKNOWN",
          message: "No se pudo generar el audio de voz.",
        });
        return;
      }

      const rawBuffer = Buffer.from(base64Audio, "base64");
      const wavBuffer = ensureWavBuffer(rawBuffer, 24000);

      res.setHeader("Content-Type", "audio/wav");
      res.setHeader("Cache-Control", "no-store");
      res.send(wavBuffer);
    } catch (error) {
      console.error("Gemini TTS API Error:", error);
      const classified = classifyGeminiError(error, "gemini-3.8-flash-lite-tts");
      res.status(classified.status).json({
        errorType: classified.errorType,
        message: classified.message,
      });
    }
  });

  // Create & Edit Images with gemini-nano-banana-2.1
  app.post("/api/gemini/image", async (req: Request, res: Response) => {
    const modelName = "gemini-nano-banana-2.1";
    try {
      const { prompt, imageBase64, imageMimeType, aspectRatio, imageSize, useSearch } =
        req.body as {
          prompt?: unknown;
          imageBase64?: unknown;
          imageMimeType?: unknown;
          aspectRatio?: unknown;
          imageSize?: unknown;
          useSearch?: unknown;
        };

      if (typeof prompt !== "string" || !prompt.trim()) {
        res.status(400).json({
          errorType: "UNKNOWN",
          message: "Señor, debe proporcionar una descripción para crear o editar la imagen.",
        });
        return;
      }

      const result = await generateImageInternal({
        prompt,
        imageBase64: typeof imageBase64 === "string" ? imageBase64 : undefined,
        imageMimeType: typeof imageMimeType === "string" ? imageMimeType : undefined,
        aspectRatio: typeof aspectRatio === "string" ? aspectRatio : undefined,
        imageSize: typeof imageSize === "string" ? imageSize : undefined,
        useSearch: Boolean(useSearch),
      });

      if (!result.imageUrl) {
        res.status(502).json({
          errorType: "UNKNOWN",
          message:
            result.text ||
            "No se generó ninguna imagen en la respuesta, Señor. Intente ajustar la descripción.",
        });
        return;
      }

      res.json(result);
    } catch (error) {
      console.error("Gemini Image API Error:", error);
      const classified = classifyGeminiError(error, modelName);
      res.status(classified.status).json({
        errorType: classified.errorType,
        message: classified.message,
      });
    }
  });

  // Text-to-Video & Image-to-Video using gemini-omni-1.2-flash via Interactions API
  app.post("/api/gemini/video", async (req: Request, res: Response) => {
    const modelName = "gemini-omni-1.2-flash";
    try {
      const { prompt, imageBase64, imageMimeType, aspectRatio, duration, resolution } =
        req.body as {
          prompt?: unknown;
          imageBase64?: unknown;
          imageMimeType?: unknown;
          aspectRatio?: unknown;
          duration?: unknown;
          resolution?: unknown;
        };

      if (typeof prompt !== "string" || !prompt.trim()) {
        res.status(400).json({
          errorType: "UNKNOWN",
          message: "Señor, debe proporcionar una descripción para generar el video.",
        });
        return;
      }

      const safeAspectRatio = aspectRatio === "9:16" ? "9:16" : "16:9";
      const validDurations = new Set(["5s", "8s", "10s"]);
      const safeDuration =
        typeof duration === "string" && validDurations.has(duration) ? duration : "5s";
      const safeResolution = resolution === "1080p" ? "1080p" : "720p";

      const hasImage = typeof imageBase64 === "string" && imageBase64.trim().length > 0;
      const input = hasImage
        ? [
            {
              type: "image" as const,
              mime_type:
                typeof imageMimeType === "string" && imageMimeType.trim()
                  ? imageMimeType.trim()
                  : "image/png",
              data: (imageBase64 as string).trim(),
            },
            {
              type: "text" as const,
              text: prompt.trim(),
            },
          ]
        : prompt.trim();

      const ai = getAiClient();
      const interaction = await ai.interactions.create(
        {
          model: modelName,
          input,
          background: true,
          store: true,
          response_format: {
            type: "video",
            aspect_ratio: safeAspectRatio,
            duration: safeDuration,
            resolution: safeResolution,
          },
        },
        { timeout: 60000 }
      );

      if (interaction.status === "completed") {
        const videoPart = interaction.output_video;
        if (videoPart?.data) {
          const mime = videoPart.mime_type || "video/mp4";
          res.json({
            interactionId: interaction.id,
            status: "completed",
            videoUrl: `data:${mime};base64,${videoPart.data}`,
          });
          return;
        }
        if (videoPart?.uri) {
          res.json({
            interactionId: interaction.id,
            status: "completed",
            videoUrl: videoPart.uri,
          });
          return;
        }
      }

      res.json({
        interactionId: interaction.id,
        status: interaction.status || "in_progress",
      });
    } catch (error) {
      console.error("Gemini Video API Error:", error);
      const classified = classifyGeminiError(error, modelName);
      res.status(classified.status).json({
        errorType: classified.errorType,
        message: classified.message,
      });
    }
  });

  // Poll video generation interaction status
  app.get("/api/gemini/video/:id", async (req: Request, res: Response) => {
    const modelName = "gemini-omni-1.2-flash";
    try {
      const interactionId = req.params.id;
      if (!interactionId) {
        res.status(400).json({ errorType: "UNKNOWN", message: "ID de interacción requerido." });
        return;
      }

      const ai = getAiClient();
      const interaction = await ai.interactions.get(interactionId);

      if (interaction.status === "completed") {
        const videoPart = interaction.output_video;
        if (videoPart?.data) {
          const mime = videoPart.mime_type || "video/mp4";
          res.json({
            interactionId: interaction.id,
            status: "completed",
            videoUrl: `data:${mime};base64,${videoPart.data}`,
          });
          return;
        }
        if (videoPart?.uri) {
          res.json({
            interactionId: interaction.id,
            status: "completed",
            videoUrl: videoPart.uri,
          });
          return;
        }
        res.status(502).json({
          errorType: "UNKNOWN",
          status: "failed",
          message: "La generación finalizó pero no devolvió un archivo de video.",
        });
        return;
      }

      if (interaction.status === "failed" || interaction.status === "cancelled") {
        res.status(500).json({
          errorType: "UNKNOWN",
          status: interaction.status,
          message: "Señor, la generación de video falló o fue cancelada.",
        });
        return;
      }

      res.json({
        interactionId: interaction.id,
        status: interaction.status,
      });
    } catch (error) {
      console.error("Gemini Video Poll Error:", error);
      const classified = classifyGeminiError(error, modelName);
      res.status(classified.status).json({
        errorType: classified.errorType,
        message: classified.message,
      });
    }
  });

  if (process.env.NODE_ENV !== "production") {
    const { createServer: createViteServer } = await import("vite");
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: "spa",
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(__dirname, "dist");
    app.use(express.static(distPath));
    app.get("*", (_req: Request, res: Response) => {
      res.sendFile(path.join(distPath, "index.html"));
    });
  }

  app.listen(PORT, "0.0.0.0", () => {
    console.log(`J.A.R.V.Y.S. server listening on http://localhost:${PORT}`);
  });
}

startServer().catch((err) => {
  console.error("Failed to start server:", err);
  process.exit(1);
});
