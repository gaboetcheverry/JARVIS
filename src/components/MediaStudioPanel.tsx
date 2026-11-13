import { useState, useEffect, useRef, type ChangeEvent } from 'react';
import {
  Image as ImageIcon,
  Film,
  Upload,
  Sparkles,
  Download,
  Loader2,
  Globe,
  X,
  ArrowRight,
} from 'lucide-react';
import {
  generateOrEditImage,
  startVideoGeneration,
  pollVideoGeneration,
  GeminiError,
  type SearchSource,
} from '../services/geminiService';

type StudioTab = 'image' | 'video';

interface UploadedPhoto {
  base64: string;
  mimeType: string;
  previewUrl: string;
  name: string;
}

function readFileAsBase64(file: File): Promise<UploadedPhoto> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const dataUrl = String(reader.result || '');
      const commaIdx = dataUrl.indexOf(',');
      const base64 = commaIdx >= 0 ? dataUrl.slice(commaIdx + 1) : '';
      resolve({
        base64,
        mimeType: file.type || 'image/png',
        previewUrl: dataUrl,
        name: file.name,
      });
    };
    reader.onerror = () => reject(new Error('No se pudo leer el archivo seleccionado.'));
    reader.readAsDataURL(file);
  });
}

function dataUrlToUploadedPhoto(dataUrl: string, name: string): UploadedPhoto | null {
  const match = dataUrl.match(/^data:([^;]+);base64,(.+)$/);
  if (!match) return null;
  return {
    mimeType: match[1],
    base64: match[2],
    previewUrl: dataUrl,
    name,
  };
}

export function MediaStudioPanel({
  initialTab = 'image',
  sharedImageUrl,
  onImageGenerated,
}: {
  initialTab?: StudioTab;
  sharedImageUrl?: string | null;
  onImageGenerated?: (url: string) => void;
}) {
  const [studioTab, setStudioTab] = useState<StudioTab>(initialTab);

  useEffect(() => {
    setStudioTab(initialTab);
  }, [initialTab]);

  // Image Creation & Editing State (gemini-nano-banana-2.1)
  const [imagePrompt, setImagePrompt] = useState('');
  const [sourceImage, setSourceImage] = useState<UploadedPhoto | null>(null);
  const [imageAspectRatio, setImageAspectRatio] = useState<
    '1:1' | '16:9' | '9:16' | '4:3' | '3:4'
  >('1:1');
  const [imageSize, setImageSize] = useState<'1K' | '2K' | '4K'>('1K');
  const [imageUseSearch, setImageUseSearch] = useState(false);
  const [imageLoading, setImageLoading] = useState(false);
  const [generatedImageUrl, setGeneratedImageUrl] = useState<string | null>(
    sharedImageUrl ?? null
  );
  const [generatedImageText, setGeneratedImageText] = useState('');
  const [imageSources, setImageSources] = useState<SearchSource[]>([]);
  const [imageError, setImageError] = useState<string | null>(null);

  useEffect(() => {
    if (sharedImageUrl) {
      setGeneratedImageUrl(sharedImageUrl);
    }
  }, [sharedImageUrl]);

  // Video Generation & Animation State (gemini-omni-1.2-flash via Interactions API)
  const [videoPrompt, setVideoPrompt] = useState('');
  const [videoPhoto, setVideoPhoto] = useState<UploadedPhoto | null>(null);
  const [videoAspectRatio, setVideoAspectRatio] = useState<'16:9' | '9:16'>('16:9');
  const [videoDuration, setVideoDuration] = useState<'5s' | '8s' | '10s'>('5s');
  const [videoLoading, setVideoLoading] = useState(false);
  const [videoStatusText, setVideoStatusText] = useState('');
  const [generatedVideoUrl, setGeneratedVideoUrl] = useState<string | null>(null);
  const [videoError, setVideoError] = useState<string | null>(null);

  const pollTimerRef = useRef<number | null>(null);

  useEffect(() => {
    return () => {
      if (pollTimerRef.current) {
        window.clearTimeout(pollTimerRef.current);
      }
    };
  }, []);

  const handleImageUpload = async (e: ChangeEvent<HTMLInputElement>, target: 'image' | 'video') => {
    const file = e.target.files?.[0];
    if (!file) return;
    try {
      const uploaded = await readFileAsBase64(file);
      if (target === 'image') {
        setSourceImage(uploaded);
      } else {
        setVideoPhoto(uploaded);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Error leyendo la imagen.';
      if (target === 'image') setImageError(msg);
      else setVideoError(msg);
    } finally {
      e.target.value = '';
    }
  };

  const handleGenerateImage = async () => {
    if (!imagePrompt.trim() || imageLoading) return;
    setImageLoading(true);
    setImageError(null);

    try {
      const result = await generateOrEditImage({
        prompt: imagePrompt.trim(),
        imageBase64: sourceImage?.base64,
        imageMimeType: sourceImage?.mimeType,
        aspectRatio: imageAspectRatio,
        imageSize,
        useSearch: imageUseSearch,
      });
      setGeneratedImageUrl(result.imageUrl);
      onImageGenerated?.(result.imageUrl);
      setGeneratedImageText(result.text);
      setImageSources(result.sources);
    } catch (err) {
      const msg =
        err instanceof GeminiError || err instanceof Error
          ? err.message
          : 'No se pudo generar la imagen.';
      setImageError(msg);
    } finally {
      setImageLoading(false);
    }
  };

  const handleAnimateGeneratedImage = () => {
    if (!generatedImageUrl) return;
    const converted = dataUrlToUploadedPhoto(generatedImageUrl, 'stark_generated.png');
    if (converted) {
      setVideoPhoto(converted);
      setStudioTab('video');
    }
  };

  const handleEditGeneratedImage = () => {
    if (!generatedImageUrl) return;
    const converted = dataUrlToUploadedPhoto(generatedImageUrl, 'stark_edit_base.png');
    if (converted) {
      setSourceImage(converted);
    }
  };

  const handleGenerateVideo = async () => {
    if (!videoPrompt.trim() || videoLoading) return;
    if (pollTimerRef.current) {
      window.clearTimeout(pollTimerRef.current);
    }

    setVideoLoading(true);
    setVideoError(null);
    setGeneratedVideoUrl(null);
    setVideoStatusText('Iniciando síntesis con Omni Flash...');

    try {
      const initial = await startVideoGeneration({
        prompt: videoPrompt.trim(),
        imageBase64: videoPhoto?.base64,
        imageMimeType: videoPhoto?.mimeType,
        aspectRatio: videoAspectRatio,
        duration: videoDuration,
        resolution: '720p',
      });

      if (initial.status === 'completed' && initial.videoUrl) {
        setGeneratedVideoUrl(initial.videoUrl);
        setVideoStatusText('');
        setVideoLoading(false);
        return;
      }

      const poll = async (interactionId: string, attempts: number) => {
        if (attempts > 60) {
          setVideoError('Tiempo de espera agotado al generar el video, Señor.');
          setVideoLoading(false);
          setVideoStatusText('');
          return;
        }
        try {
          setVideoStatusText(`Renderizando secuencia (${attempts * 4}s)...`);
          const res = await pollVideoGeneration(interactionId);
          if (res.status === 'completed' && res.videoUrl) {
            setGeneratedVideoUrl(res.videoUrl);
            setVideoLoading(false);
            setVideoStatusText('');
          } else {
            pollTimerRef.current = window.setTimeout(() => {
              void poll(interactionId, attempts + 1);
            }, 4000);
          }
        } catch (err) {
          const msg =
            err instanceof GeminiError || err instanceof Error
              ? err.message
              : 'Error consultando el estado del video.';
          setVideoError(msg);
          setVideoLoading(false);
          setVideoStatusText('');
        }
      };

      pollTimerRef.current = window.setTimeout(() => {
        void poll(initial.interactionId, 1);
      }, 4000);
    } catch (err) {
      const msg =
        err instanceof GeminiError || err instanceof Error
          ? err.message
          : 'No se pudo iniciar la generación de video.';
      setVideoError(msg);
      setVideoLoading(false);
      setVideoStatusText('');
    }
  };

  return (
    <div className="space-y-4">
      {/* Studio Sub-tabs */}
      <div className="flex gap-2">
        <button
          type="button"
          onClick={() => setStudioTab('image')}
          className={`flex-1 py-2.5 px-4 rounded-lg border text-xs uppercase tracking-wider flex items-center justify-center gap-2 cursor-pointer transition-colors ${
            studioTab === 'image'
              ? 'bg-[#42d1f5]/20 border-[#42d1f5] text-white'
              : 'bg-[#42d1f5]/5 border-[#42d1f5]/20 text-[#42d1f5]/70 hover:border-[#42d1f5]/50'
          }`}
        >
          <ImageIcon size={14} />
          <span>Crear y Editar Imágenes</span>
        </button>
        <button
          type="button"
          onClick={() => setStudioTab('video')}
          className={`flex-1 py-2.5 px-4 rounded-lg border text-xs uppercase tracking-wider flex items-center justify-center gap-2 cursor-pointer transition-colors ${
            studioTab === 'video'
              ? 'bg-[#42d1f5]/20 border-[#42d1f5] text-white'
              : 'bg-[#42d1f5]/5 border-[#42d1f5]/20 text-[#42d1f5]/70 hover:border-[#42d1f5]/50'
          }`}
        >
          <Film size={14} />
          <span>Video y Animación</span>
        </button>
      </div>

      {studioTab === 'image' ? (
        <div className="bg-[#42d1f5]/5 border border-[#42d1f5]/20 rounded-lg p-5 space-y-4">
          <div className="flex flex-wrap items-center justify-between gap-2 text-[11px] uppercase tracking-widest opacity-70">
            <span>Estudio Visual · gemini-nano-banana-2.1</span>
            <label className="inline-flex items-center gap-1.5 cursor-pointer text-xs normal-case tracking-normal text-[#42d1f5]">
              <input
                type="checkbox"
                checked={imageUseSearch}
                onChange={(e) => setImageUseSearch(e.target.checked)}
                className="accent-[#42d1f5]"
              />
              <Globe size={12} />
              <span>Búsqueda web e imágenes</span>
            </label>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div>
              <label className="block text-[10px] uppercase tracking-wider opacity-60 mb-1">
                Relación de aspecto
              </label>
              <select
                value={imageAspectRatio}
                onChange={(e) =>
                  setImageAspectRatio(
                    e.target.value as '1:1' | '16:9' | '9:16' | '4:3' | '3:4'
                  )
                }
                className="w-full bg-black/70 border border-[#42d1f5]/25 rounded px-3 py-2 text-xs text-white focus:outline-none focus:border-[#42d1f5]"
              >
                <option value="1:1">1:1 (Cuadrada)</option>
                <option value="16:9">16:9 (Horizontal)</option>
                <option value="9:16">9:16 (Vertical)</option>
                <option value="4:3">4:3 (Clásica)</option>
                <option value="3:4">3:4 (Retrato)</option>
              </select>
            </div>
            <div>
              <label className="block text-[10px] uppercase tracking-wider opacity-60 mb-1">
                Resolución
              </label>
              <select
                value={imageSize}
                onChange={(e) => setImageSize(e.target.value as '1K' | '2K' | '4K')}
                className="w-full bg-black/70 border border-[#42d1f5]/25 rounded px-3 py-2 text-xs text-white focus:outline-none focus:border-[#42d1f5]"
              >
                <option value="1K">1K Estándar</option>
                <option value="2K">2K Alta Definición</option>
                <option value="4K">4K Ultra HD</option>
              </select>
            </div>
          </div>

          {/* Optional source image upload for editing */}
          <div className="flex flex-wrap items-center gap-3">
            <label className="inline-flex items-center gap-2 px-3 py-2 rounded border border-[#42d1f5]/30 bg-black/40 hover:bg-[#42d1f5]/10 text-xs cursor-pointer transition-colors">
              <Upload size={13} />
              <span>{sourceImage ? 'Cambiar imagen a editar' : 'Subir imagen para editar (opcional)'}</span>
              <input
                type="file"
                accept="image/*"
                className="hidden"
                onChange={(e) => void handleImageUpload(e, 'image')}
              />
            </label>
            {sourceImage && (
              <div className="flex items-center gap-2 bg-black/50 border border-[#42d1f5]/25 rounded px-2.5 py-1 text-xs">
                <img
                  src={sourceImage.previewUrl}
                  alt="Base"
                  className="w-7 h-7 object-cover rounded"
                />
                <span className="max-w-[140px] truncate text-white/80">{sourceImage.name}</span>
                <button
                  type="button"
                  onClick={() => setSourceImage(null)}
                  className="text-[#42d1f5]/70 hover:text-white cursor-pointer"
                >
                  <X size={13} />
                </button>
              </div>
            )}
          </div>

          <div className="flex gap-2">
            <input
              type="text"
              value={imagePrompt}
              onChange={(e) => setImagePrompt(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') void handleGenerateImage();
              }}
              placeholder={
                sourceImage
                  ? 'Describe cómo editar esta imagen (ej. añade reflejos holográficos azules)...'
                  : 'Describe la imagen que deseas crear...'
              }
              className="flex-1 bg-black/50 border border-[#42d1f5]/25 rounded-lg px-4 py-2.5 text-sm text-white placeholder-[#42d1f5]/40 focus:outline-none focus:border-[#42d1f5]"
            />
            <button
              type="button"
              onClick={() => void handleGenerateImage()}
              disabled={!imagePrompt.trim() || imageLoading}
              className="px-4 py-2.5 rounded-lg border border-[#42d1f5]/40 bg-[#42d1f5]/15 hover:bg-[#42d1f5]/30 disabled:opacity-40 text-xs uppercase tracking-wider flex items-center gap-2 cursor-pointer"
            >
              {imageLoading ? (
                <Loader2 size={14} className="animate-spin" />
              ) : (
                <Sparkles size={14} />
              )}
              <span>{sourceImage ? 'Editar' : 'Crear'}</span>
            </button>
          </div>

          {imageError && (
            <div className="p-3 rounded border border-amber-500/40 bg-amber-500/10 text-amber-200 text-xs">
              {imageError}
            </div>
          )}

          {generatedImageUrl && (
            <div className="space-y-3 pt-2">
              <div className="rounded-lg overflow-hidden border border-[#42d1f5]/30 bg-black flex justify-center">
                <img
                  src={generatedImageUrl}
                  alt="Generada por J.A.R.V.Y.S."
                  className="max-h-[380px] object-contain"
                />
              </div>
              {generatedImageText && (
                <p className="text-xs text-white/75">{generatedImageText}</p>
              )}
              <div className="flex flex-wrap gap-2">
                <a
                  href={generatedImageUrl}
                  download="jarvis_imagen.png"
                  className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded border border-[#42d1f5]/35 text-xs hover:bg-[#42d1f5]/15"
                >
                  <Download size={13} />
                  <span>Descargar</span>
                </a>
                <button
                  type="button"
                  onClick={handleEditGeneratedImage}
                  className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded border border-[#42d1f5]/35 text-xs hover:bg-[#42d1f5]/15 cursor-pointer"
                >
                  <ImageIcon size={13} />
                  <span>Seguir editando</span>
                </button>
                <button
                  type="button"
                  onClick={handleAnimateGeneratedImage}
                  className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded border border-[#42d1f5]/35 text-xs hover:bg-[#42d1f5]/15 cursor-pointer"
                >
                  <span>Animar en Video</span>
                  <ArrowRight size={13} />
                </button>
              </div>
              {imageSources.length > 0 && (
                <div className="text-[11px] space-y-1 pt-1 opacity-75">
                  <span className="uppercase tracking-wider">Fuentes:</span>
                  <div className="flex flex-wrap gap-2">
                    {imageSources.map((s, i) => (
                      <a
                        key={i}
                        href={s.uri}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="underline hover:text-white"
                      >
                        {s.title}
                      </a>
                    ))}
                  </div>
                </div>
              )}
            </div>
          )}
        </div>
      ) : (
        <div className="bg-[#42d1f5]/5 border border-[#42d1f5]/20 rounded-lg p-5 space-y-4">
          <div className="text-[11px] uppercase tracking-widest opacity-70">
            Estudio de Movimiento · gemini-omni-1.2-flash (Interactions API)
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div>
              <label className="block text-[10px] uppercase tracking-wider opacity-60 mb-1">
                Formato de Video
              </label>
              <select
                value={videoAspectRatio}
                onChange={(e) => setVideoAspectRatio(e.target.value as '16:9' | '9:16')}
                className="w-full bg-black/70 border border-[#42d1f5]/25 rounded px-3 py-2 text-xs text-white focus:outline-none focus:border-[#42d1f5]"
              >
                <option value="16:9">16:9 (Horizontal / Landscape)</option>
                <option value="9:16">9:16 (Vertical / Portrait)</option>
              </select>
            </div>
            <div>
              <label className="block text-[10px] uppercase tracking-wider opacity-60 mb-1">
                Duración
              </label>
              <select
                value={videoDuration}
                onChange={(e) => setVideoDuration(e.target.value as '5s' | '8s' | '10s')}
                className="w-full bg-black/70 border border-[#42d1f5]/25 rounded px-3 py-2 text-xs text-white focus:outline-none focus:border-[#42d1f5]"
              >
                <option value="5s">5 segundos</option>
                <option value="8s">8 segundos</option>
                <option value="10s">10 segundos</option>
              </select>
            </div>
          </div>

          {/* Optional photo upload to animate */}
          <div className="flex flex-wrap items-center gap-3">
            <label className="inline-flex items-center gap-2 px-3 py-2 rounded border border-[#42d1f5]/30 bg-black/40 hover:bg-[#42d1f5]/10 text-xs cursor-pointer transition-colors">
              <Upload size={13} />
              <span>{videoPhoto ? 'Cambiar foto base' : 'Subir foto para animar (opcional)'}</span>
              <input
                type="file"
                accept="image/*"
                className="hidden"
                onChange={(e) => void handleImageUpload(e, 'video')}
              />
            </label>
            {videoPhoto && (
              <div className="flex items-center gap-2 bg-black/50 border border-[#42d1f5]/25 rounded px-2.5 py-1 text-xs">
                <img
                  src={videoPhoto.previewUrl}
                  alt="Frame inicial"
                  className="w-7 h-7 object-cover rounded"
                />
                <span className="max-w-[140px] truncate text-white/80">{videoPhoto.name}</span>
                <button
                  type="button"
                  onClick={() => setVideoPhoto(null)}
                  className="text-[#42d1f5]/70 hover:text-white cursor-pointer"
                >
                  <X size={13} />
                </button>
              </div>
            )}
          </div>

          <div className="flex gap-2">
            <input
              type="text"
              value={videoPrompt}
              onChange={(e) => setVideoPrompt(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') void handleGenerateVideo();
              }}
              placeholder={
                videoPhoto
                  ? 'Describe el movimiento para animar la foto...'
                  : 'Describe la escena de video a generar desde texto...'
              }
              className="flex-1 bg-black/50 border border-[#42d1f5]/25 rounded-lg px-4 py-2.5 text-sm text-white placeholder-[#42d1f5]/40 focus:outline-none focus:border-[#42d1f5]"
            />
            <button
              type="button"
              onClick={() => void handleGenerateVideo()}
              disabled={!videoPrompt.trim() || videoLoading}
              className="px-4 py-2.5 rounded-lg border border-[#42d1f5]/40 bg-[#42d1f5]/15 hover:bg-[#42d1f5]/30 disabled:opacity-40 text-xs uppercase tracking-wider flex items-center gap-2 cursor-pointer"
            >
              {videoLoading ? (
                <Loader2 size={14} className="animate-spin" />
              ) : (
                <Film size={14} />
              )}
              <span>{videoPhoto ? 'Animar' : 'Generar'}</span>
            </button>
          </div>

          {videoStatusText && (
            <div className="flex items-center gap-2 text-xs text-[#42d1f5]">
              <Loader2 size={14} className="animate-spin" />
              <span>{videoStatusText}</span>
            </div>
          )}

          {videoError && (
            <div className="p-3 rounded border border-amber-500/40 bg-amber-500/10 text-amber-200 text-xs">
              {videoError}
            </div>
          )}

          {generatedVideoUrl && (
            <div className="space-y-3 pt-2">
              <div className="rounded-lg overflow-hidden border border-[#42d1f5]/30 bg-black">
                <video
                  src={generatedVideoUrl}
                  controls
                  autoPlay
                  loop
                  className="w-full max-h-[380px]"
                />
              </div>
              <a
                href={generatedVideoUrl}
                download="jarvis_video.mp4"
                className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded border border-[#42d1f5]/35 text-xs hover:bg-[#42d1f5]/15"
              >
                <Download size={13} />
                <span>Descargar MP4</span>
              </a>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
