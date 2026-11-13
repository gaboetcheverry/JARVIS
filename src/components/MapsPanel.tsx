import { useState, useEffect, useRef, useCallback } from 'react';
import {
  APIProvider,
  Map as GoogleMap,
  AdvancedMarker,
  Pin,
  InfoWindow,
  useMap,
  useMapsLibrary,
  useApiLoadingStatus,
  APILoadingStatus,
} from '@vis.gl/react-google-maps';
import {
  Search,
  Navigation,
  MapPin,
  Crosshair,
  Route as RouteIcon,
  Loader2,
  X,
} from 'lucide-react';

interface MapsPanelProps {
  apiKey: string;
  initialQuery?: string;
}

interface SelectedPlaceInfo {
  name: string;
  address: string;
  position: google.maps.LatLngLiteral;
}

interface RouteSummary {
  distanceKm: string;
  durationMin: number;
}

type TravelModeOption = 'DRIVING' | 'WALKING' | 'BICYCLING' | 'TRANSIT';

const DEFAULT_CENTER: google.maps.LatLngLiteral = { lat: 37.7749, lng: -122.4194 };

function checkQuotaError(err: unknown) {
  const msg = err instanceof Error ? err.message : String(err);
  const status = (err as { status?: number | string; code?: string })?.status;
  const code = (err as { code?: string })?.code;
  if (
    msg.includes('OVER_QUERY_LIMIT') ||
    msg.includes('RESOURCE_EXHAUSTED') ||
    msg.includes('QuotaExceededError') ||
    msg.includes('429') ||
    status === 429 ||
    status === 'OVER_QUERY_LIMIT' ||
    status === 'RESOURCE_EXHAUSTED' ||
    code === 'OVER_QUERY_LIMIT'
  ) {
    window.dispatchEvent(new CustomEvent('gmp-quota-exceeded'));
  }
}

function MapsInner({
  selectedPlace,
  setSelectedPlace,
  userLocation,
  setUserLocation,
  initialQuery,
}: {
  selectedPlace: SelectedPlaceInfo | null;
  setSelectedPlace: (p: SelectedPlaceInfo | null) => void;
  userLocation: google.maps.LatLngLiteral | null;
  setUserLocation: (loc: google.maps.LatLngLiteral | null) => void;
  initialQuery?: string;
}) {
  const map = useMap();
  const placesLib = useMapsLibrary('places');
  const routesLib = useMapsLibrary('routes');
  const loadingStatus = useApiLoadingStatus();

  // Place autocomplete state
  const [searchInput, setSearchInput] = useState(initialQuery || '');
  const [suggestions, setSuggestions] = useState<google.maps.places.AutocompleteSuggestion[]>([]);
  const [isSearching, setIsSearching] = useState(false);
  const sessionTokenRef = useRef<google.maps.places.AutocompleteSessionToken | null>(null);

  useEffect(() => {
    if (initialQuery) {
      setSearchInput(initialQuery);
    }
  }, [initialQuery]);

  // InfoWindow anchor state
  const [markerInstance, setMarkerInstance] =
    useState<google.maps.marker.AdvancedMarkerElement | null>(null);
  const [infoOpen, setInfoOpen] = useState(false);

  // Routing state
  const [originInput, setOriginInput] = useState('');
  const [destinationInput, setDestinationInput] = useState('');
  const [travelMode, setTravelMode] = useState<TravelModeOption>('DRIVING');
  const [routeSummary, setRouteSummary] = useState<RouteSummary | null>(null);
  const [routeLoading, setRouteLoading] = useState(false);
  const [routeError, setRouteError] = useState<string | null>(null);
  const polylinesRef = useRef<google.maps.Polyline[]>([]);

  useEffect(() => {
    if (loadingStatus === APILoadingStatus.AUTH_FAILURE) {
      window.dispatchEvent(new CustomEvent('gmp-quota-exceeded'));
    }
  }, [loadingStatus]);

  useEffect(() => {
    if (!placesLib || !searchInput.trim()) {
      setSuggestions([]);
      return;
    }

    const { AutocompleteSessionToken, AutocompleteSuggestion } = placesLib;
    if (!sessionTokenRef.current) {
      sessionTokenRef.current = new AutocompleteSessionToken();
    }

    let cancelled = false;
    setIsSearching(true);

    const timer = setTimeout(() => {
      const request: google.maps.places.AutocompleteRequest = {
        input: searchInput.trim(),
        sessionToken: sessionTokenRef.current ?? undefined,
      };

      AutocompleteSuggestion.fetchAutocompleteSuggestions(request)
        .then((res) => {
          if (!cancelled) {
            setSuggestions(res.suggestions || []);
            setIsSearching(false);
          }
        })
        .catch((err) => {
          console.error('Autocomplete error:', err);
          checkQuotaError(err);
          if (!cancelled) {
            setSuggestions([]);
            setIsSearching(false);
          }
        });
    }, 220);

    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [placesLib, searchInput]);

  const handleSelectSuggestion = useCallback(
    async (suggestion: google.maps.places.AutocompleteSuggestion) => {
      if (!placesLib || !suggestion.placePrediction) return;
      try {
        const place = suggestion.placePrediction.toPlace();
        await place.fetchFields({
          fields: ['displayName', 'formattedAddress', 'location', 'viewport'],
        });

        const loc = place.location;
        if (loc && map) {
          const latLng: google.maps.LatLngLiteral = {
            lat: loc.lat(),
            lng: loc.lng(),
          };
          const info: SelectedPlaceInfo = {
            name: place.displayName || suggestion.placePrediction.text.text,
            address: place.formattedAddress || '',
            position: latLng,
          };
          setSelectedPlace(info);
          setInfoOpen(true);
          setDestinationInput(info.address || info.name);

          if (place.viewport) {
            map.fitBounds(place.viewport);
          } else {
            map.panTo(latLng);
            map.setZoom(15);
          }
        }

        sessionTokenRef.current = null;
        setSuggestions([]);
        setSearchInput('');
      } catch (err) {
        console.error('Place fetchFields error:', err);
        checkQuotaError(err);
      }
    },
    [placesLib, map, setSelectedPlace]
  );

  const handleGeolocate = () => {
    if (!navigator.geolocation) {
      setRouteError('Señor, la geolocalización no está disponible en este navegador.');
      return;
    }
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        const loc = {
          lat: pos.coords.latitude,
          lng: pos.coords.longitude,
        };
        setUserLocation(loc);
        setOriginInput(`${loc.lat.toFixed(5)}, ${loc.lng.toFixed(5)}`);
        if (map) {
          map.panTo(loc);
          map.setZoom(14);
        }
      },
      () => {
        setRouteError('Señor, no se obtuvo permiso para leer su ubicación actual.');
      }
    );
  };

  const clearRoute = () => {
    polylinesRef.current.forEach((p) => p.setMap(null));
    polylinesRef.current = [];
    setRouteSummary(null);
    setRouteError(null);
  };

  useEffect(() => {
    return () => {
      polylinesRef.current.forEach((p) => p.setMap(null));
      polylinesRef.current = [];
    };
  }, []);

  const handleComputeRoute = async () => {
    if (!routesLib || !map) return;
    if (!originInput.trim() || !destinationInput.trim()) {
      setRouteError('Ingrese origen y destino para calcular la ruta.');
      return;
    }

    clearRoute();
    setRouteLoading(true);
    setRouteError(null);

    try {
      const request = {
        origin: originInput.trim(),
        destination: destinationInput.trim(),
        travelMode,
        fields: ['path', 'distanceMeters', 'durationMillis', 'viewport'],
      };

      const { routes } = await (routesLib.Route as unknown as {
        computeRoutes: (req: typeof request) => Promise<{ routes: google.maps.routes.Route[] }>;
      }).computeRoutes(request);

      if (!routes || routes.length === 0) {
        setRouteError('No se encontró una ruta válida entre esos puntos.');
        setRouteLoading(false);
        return;
      }

      const primaryRoute = routes[0];
      const newPolylines = primaryRoute.createPolylines();
      newPolylines.forEach((polyline) => {
        polyline.setOptions({
          strokeColor: '#42d1f5',
          strokeWeight: 5,
          strokeOpacity: 0.9,
        });
        polyline.setMap(map);
      });
      polylinesRef.current = newPolylines;

      if (primaryRoute.viewport) {
        map.fitBounds(primaryRoute.viewport);
      }

      setRouteSummary({
        distanceKm: ((primaryRoute.distanceMeters ?? 0) / 1000).toFixed(2),
        durationMin: Math.max(1, Math.round((primaryRoute.durationMillis ?? 0) / 60000)),
      });
    } catch (err) {
      console.error('Compute route error:', err);
      checkQuotaError(err);
      setRouteError('No fue posible calcular la ruta. Verifique las direcciones o la red.');
    } finally {
      setRouteLoading(false);
    }
  };

  return (
    <div className="space-y-4">
      {/* Search & Location Controls */}
      <div className="grid grid-cols-1 md:grid-cols-12 gap-3">
        <div className="md:col-span-8 relative">
          <div className="flex items-center bg-[#42d1f5]/5 border border-[#42d1f5]/25 rounded-lg px-3 py-2.5">
            <Search size={15} className="text-[#42d1f5]/60 mr-2 shrink-0" />
            <input
              type="text"
              value={searchInput}
              onChange={(e) => setSearchInput(e.target.value)}
              placeholder="Buscar lugares, direcciones o puntos de interés..."
              className="w-full bg-transparent text-sm text-white placeholder-[#42d1f5]/40 focus:outline-none"
            />
            {isSearching && <Loader2 size={14} className="animate-spin text-[#42d1f5]" />}
          </div>

          {suggestions.length > 0 && (
            <ul className="absolute left-0 right-0 mt-1 bg-[#0a0f14] border border-[#42d1f5]/35 rounded-lg shadow-xl z-30 max-h-60 overflow-y-auto divide-y divide-[#42d1f5]/10">
              {suggestions.map((s, idx) => (
                <li
                  key={idx}
                  onClick={() => void handleSelectSuggestion(s)}
                  className="px-3 py-2.5 text-xs text-white/85 hover:bg-[#42d1f5]/15 cursor-pointer flex items-center gap-2"
                >
                  <MapPin size={13} className="text-[#42d1f5] shrink-0" />
                  <span>{s.placePrediction?.text.text}</span>
                </li>
              ))}
            </ul>
          )}
        </div>

        <div className="md:col-span-4 flex gap-2">
          <button
            type="button"
            onClick={handleGeolocate}
            className="flex-1 px-3 py-2.5 text-xs uppercase tracking-wider border border-[#42d1f5]/35 bg-[#42d1f5]/10 hover:bg-[#42d1f5]/20 rounded-lg flex items-center justify-center gap-2 cursor-pointer transition-colors"
          >
            <Crosshair size={14} />
            <span>Mi Ubicación</span>
          </button>
        </div>
      </div>

      {/* Route Planner Bar */}
      <div className="bg-[#42d1f5]/5 border border-[#42d1f5]/20 rounded-lg p-3 space-y-3">
        <div className="flex items-center justify-between text-[11px] uppercase tracking-widest opacity-70">
          <span className="flex items-center gap-1.5">
            <RouteIcon size={13} />
            Planificador de Rutas
          </span>
          {routeSummary && (
            <div className="flex items-center gap-3 text-white">
              <span>{routeSummary.distanceKm} km</span>
              <span>~{routeSummary.durationMin} min</span>
              <button
                type="button"
                onClick={clearRoute}
                className="text-[#42d1f5]/70 hover:text-white cursor-pointer"
                title="Limpiar ruta"
              >
                <X size={13} />
              </button>
            </div>
          )}
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-12 gap-2">
          <input
            type="text"
            value={originInput}
            onChange={(e) => setOriginInput(e.target.value)}
            placeholder="Origen (dirección o lat, lng)"
            className="sm:col-span-4 bg-black/50 border border-[#42d1f5]/20 rounded px-3 py-2 text-xs text-white placeholder-[#42d1f5]/35 focus:outline-none focus:border-[#42d1f5]"
          />
          <input
            type="text"
            value={destinationInput}
            onChange={(e) => setDestinationInput(e.target.value)}
            placeholder="Destino (ej. lugar seleccionado)"
            className="sm:col-span-4 bg-black/50 border border-[#42d1f5]/20 rounded px-3 py-2 text-xs text-white placeholder-[#42d1f5]/35 focus:outline-none focus:border-[#42d1f5]"
          />
          <select
            value={travelMode}
            onChange={(e) => setTravelMode(e.target.value as TravelModeOption)}
            className="sm:col-span-2 bg-black/70 border border-[#42d1f5]/20 rounded px-2 py-2 text-xs text-[#42d1f5] focus:outline-none focus:border-[#42d1f5]"
          >
            <option value="DRIVING">Auto</option>
            <option value="WALKING">A pie</option>
            <option value="BICYCLING">Bicicleta</option>
            <option value="TRANSIT">Transporte</option>
          </select>
          <button
            type="button"
            onClick={() => void handleComputeRoute()}
            disabled={routeLoading}
            className="sm:col-span-2 px-3 py-2 text-xs uppercase tracking-wider border border-[#42d1f5]/40 bg-[#42d1f5]/15 hover:bg-[#42d1f5]/25 rounded flex items-center justify-center gap-1.5 cursor-pointer disabled:opacity-40 transition-colors"
          >
            {routeLoading ? (
              <Loader2 size={13} className="animate-spin" />
            ) : (
              <Navigation size={13} />
            )}
            <span>Ruta</span>
          </button>
        </div>

        {routeError && <p className="text-xs text-amber-300">{routeError}</p>}
      </div>

      {/* Interactive Google Map */}
      <div className="relative rounded-lg overflow-hidden border border-[#42d1f5]/30 h-[440px] w-full bg-black">
        {loadingStatus === APILoadingStatus.FAILED ||
        loadingStatus === APILoadingStatus.AUTH_FAILURE ? (
          <div className="h-full w-full flex flex-col items-center justify-center p-6 text-center text-sm text-amber-300">
            <p>
              No se pudo cargar Google Maps Platform. Verifique su clave de API o cuota disponible.
            </p>
          </div>
        ) : (
          <GoogleMap
            mapId="DEMO_MAP_ID"
            defaultCenter={DEFAULT_CENTER}
            defaultZoom={12}
            gestureHandling="greedy"
            internalUsageAttributionIds={['gmp_mcp_codeassist_v1_aistudio']}
            style={{ width: '100%', height: '100%' }}
          >
            {userLocation && (
              <AdvancedMarker position={userLocation} title="Su ubicación actual">
                <Pin background="#42d1f5" borderColor="#050505" glyphColor="#050505" />
              </AdvancedMarker>
            )}

            {selectedPlace && (
              <>
                <AdvancedMarker
                  ref={setMarkerInstance}
                  position={selectedPlace.position}
                  title={selectedPlace.name}
                  onClick={() => setInfoOpen(true)}
                >
                  <Pin background="#22d3ee" borderColor="#083344" glyphColor="#083344" scale={1.2} />
                </AdvancedMarker>

                {infoOpen && markerInstance && (
                  <InfoWindow
                    anchor={markerInstance}
                    onCloseClick={() => setInfoOpen(false)}
                    maxWidth={260}
                  >
                    <div className="text-slate-900 font-sans text-xs space-y-1 p-1">
                      <p className="font-bold text-sm">{selectedPlace.name}</p>
                      {selectedPlace.address && (
                        <p className="text-slate-600">{selectedPlace.address}</p>
                      )}
                      <p className="text-[11px] text-slate-500">
                        {selectedPlace.position.lat.toFixed(5)},{' '}
                        {selectedPlace.position.lng.toFixed(5)}
                      </p>
                    </div>
                  </InfoWindow>
                )}
              </>
            )}
          </GoogleMap>
        )}
      </div>
    </div>
  );
}

export function MapsPanel({ apiKey, initialQuery }: MapsPanelProps) {
  const [selectedPlace, setSelectedPlace] = useState<SelectedPlaceInfo | null>(null);
  const [userLocation, setUserLocation] = useState<google.maps.LatLngLiteral | null>(null);

  if (!apiKey) {
    return (
      <div className="bg-[#42d1f5]/5 border border-[#42d1f5]/25 rounded-lg p-8 text-center space-y-2">
        <MapPin size={28} className="mx-auto text-[#42d1f5]/60" />
        <p className="text-sm text-white">
          Google Maps Platform está pendiente de clave de API activa.
        </p>
        <p className="text-xs opacity-60">
          Configure VITE_GOOGLE_MAPS_API_KEY en el entorno para habilitar el mapa táctico.
        </p>
      </div>
    );
  }

  return (
    <APIProvider apiKey={apiKey} language="es" region="US">
      <MapsInner
        selectedPlace={selectedPlace}
        setSelectedPlace={setSelectedPlace}
        userLocation={userLocation}
        setUserLocation={setUserLocation}
        initialQuery={initialQuery}
      />
    </APIProvider>
  );
}
