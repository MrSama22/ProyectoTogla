import * as faceapi from 'face-api.js';
import jsQR from 'jsqr';

// ==========================================
// ESTADO GLOBALES
// ==========================================
let modoActual = 'idle'; // 'idle', 'registro', 'validacion'
let dbEstudiantes = JSON.parse(localStorage.getItem('estudiantes')) || [];
let dbIngresos = JSON.parse(localStorage.getItem('ingresos')) || [];

// Generación automática de datos de prueba desactivada para producción.

// Limpieza automática de registros corruptos (Ej: cuando el QR se leyó en blanco por error)
const longitudOriginal = dbEstudiantes.length;
dbEstudiantes = dbEstudiantes.filter(est => est.qr && est.qr.trim().length >= 3 && est.descriptor && est.descriptor.length > 0);
if (dbEstudiantes.length !== longitudOriginal) {
  localStorage.setItem('estudiantes', JSON.stringify(dbEstudiantes));
  console.log("Limpieza de DB completada. Entradas corruptas eliminadas.");
}

let camaraActiva = false;
let qrDataTemporal = null;
let capturasRegistro = [];
let scanInterval = null;
let scanQRInterval = null;
let actionTimeout = null;
let currentCameraId = localStorage.getItem('selectedCameraId') || null;
let currentFacingMode = 'user'; // 'user' (frontal) o 'environment' (trasera)

// Variables para rotación dinámica
let currentRotationIdx = 0;
const rotationAngles = [0, 90, -90];
const offscreenCanvas = document.createElement('canvas');
const offCtx = offscreenCanvas.getContext('2d', { willReadFrequently: true });

// Control de vista y orientación
let cameraRotations = JSON.parse(localStorage.getItem('cameraRotations')) || {};
let cameraMirrors = JSON.parse(localStorage.getItem('cameraMirrors')) || {};
let viewRotation = 0;
let isMirrored = false;
let isAutoRotateEnabled = localStorage.getItem('autoRotateEnabled') !== 'false';

// Utilidad para evitar que la rotación regrese 360 grados hacia atrás visualmente
function getClosestRotation(current, targetNormalized) {
  const currentNormalized = ((current % 360) + 360) % 360;
  let diff = targetNormalized - currentNormalized;
  if (diff > 180) diff -= 360;
  if (diff < -180) diff += 360;
  return current + diff;
}

// Optimizador de escaneo
let stopScanningFlag = false;
let isScanning = false;
let lockedRotationAngle = null;
let lostFaceFrames = 0;

// ==========================================
// ELEMENTOS DEL DOM
// ==========================================
const video = document.getElementById('videoElement');
const canvas = document.getElementById('overlayCanvas');
const feedbackText = document.getElementById('feedbackText');
const appState = document.getElementById('appState');
const btnRegister = document.getElementById('btnRegister');
const btnLogin = document.getElementById('btnLogin');
const videoWrapper = document.querySelector('.video-wrapper');

// Elementos de Configuración de Cámara
const btnSettings = document.getElementById('btnSettings');
const cameraModal = document.getElementById('cameraModal');
const btnCloseModal = document.getElementById('btnCloseModal');
const btnClearDB = document.getElementById('btnClearDB');
const cameraSelect = document.getElementById('cameraSelect');
const autoRotateToggle = document.getElementById('autoRotateToggle');
const btnFlipCamera = document.getElementById('btnFlipCamera');
const btnRotateView = document.getElementById('btnRotateView');
const btnMirrorCamera = document.getElementById('btnMirrorCamera');
const zoomSlider = document.getElementById('zoomSlider');
const zoomLabel = document.getElementById('zoomLabel');
const faceGuide = document.getElementById('faceGuide');
const manualCodeContainer = document.getElementById('manualCodeContainer');
const manualCodeInput = document.getElementById('manualCodeInput');
const btnSubmitCode = document.getElementById('btnSubmitCode');

let currentFaceMatcher = null; // Para optimizar el inicio de sesión
let lastQRErrorTime = 0; // Para evitar spam de notificaciones QR
let currentZoom = 1; // Nivel de zoom digital
let backgroundRotationInterval = null; // Escáner de orientación en idle

// Variables de desplazamiento (Pan & Drag)
let panX = 0;
let panY = 0;
let isDragging = false;
let startX = 0;
let startY = 0;
let startPanX = 0;
let startPanY = 0;

// ==========================================
// INICIALIZACIÓN
// ==========================================
async function initApp() {
  showToast("Cargando Modelos de IA...", "warning");
  try {
    const MODEL_URL = 'https://justadudewhohacks.github.io/face-api.js/models';
    await Promise.all([
      faceapi.nets.tinyFaceDetector.loadFromUri(MODEL_URL),
      faceapi.nets.faceLandmark68Net.loadFromUri(MODEL_URL),
      faceapi.nets.faceRecognitionNet.loadFromUri(MODEL_URL)
    ]).then(async () => {
      // Warmup de la IA (Primera inferencia silenciosa para evitar lag de 7s después)
      try {
        const dummy = document.createElement('canvas');
        dummy.width = 400; dummy.height = 400;
        const options = new faceapi.TinyFaceDetectorOptions({ inputSize: 320, scoreThreshold: 0.85 });
        await faceapi.detectSingleFace(dummy, options).withFaceLandmarks().withFaceDescriptor();
      } catch(e) {}
      
      appState.textContent = 'Modelos cargados. Listo para operar';
      btnRegister.disabled = false;
      btnLogin.disabled = false;
    }).catch(err => {
      console.error("Error cargando modelos", err);
      showToast("Error cargando modelos", "error");
    });
    
    // Iniciar cámara inmediatamente después de cargar los modelos
    await startCamera();
    
    // Inicializar estado del interruptor de rotación automática
    if (autoRotateToggle) {
      autoRotateToggle.checked = isAutoRotateEnabled;
      autoRotateToggle.addEventListener('change', (e) => {
        isAutoRotateEnabled = e.target.checked;
        localStorage.setItem('autoRotateEnabled', isAutoRotateEnabled);
        showToast(isAutoRotateEnabled ? "Giro automático activado" : "Giro automático desactivado", "info");
      });
    }
    
    showToast("Sistema Listo", "success");
    feedbackText.innerHTML = "Cámara activa. Seleccione una acción (Registrar o Ingresar).";
  } catch (error) {
    showToast("Error en inicio", "error");
    console.error(error);
  }
}

// ==========================================
// MANEJO DE CÁMARA
// ==========================================
async function startCamera() {
  if (camaraActiva) return;
  try {
    let constraints = {
      video: { 
        width: { ideal: 960 }, 
        height: { ideal: 720 } 
      }
    };
    
    if (currentCameraId) {
      constraints.video.deviceId = { exact: currentCameraId };
    } else {
      constraints.video.facingMode = { ideal: currentFacingMode };
    }

    let stream;
    try {
      stream = await navigator.mediaDevices.getUserMedia(constraints);
    } catch (e) {
      console.warn("Fallo con constraints estrictos, intentando fallback...", e);
      // Fallback 1: Quitar resolución ideal y exact deviceId
      if (currentCameraId) {
        stream = await navigator.mediaDevices.getUserMedia({ video: { deviceId: currentCameraId } });
      } else {
        stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: currentFacingMode } });
      }
    }
    
    video.srcObject = stream;
    
    return new Promise((resolve) => {
      video.onloadedmetadata = () => {
        video.play();
        camaraActiva = true;
        canvas.width = video.videoWidth;
        canvas.height = video.videoHeight;
        
        // Cargar y aplicar rotación y orientación (espejo) guardada para esta cámara
        const camKey = currentCameraId || currentFacingMode;
        viewRotation = cameraRotations[camKey] || 0;
        isMirrored = cameraMirrors[camKey] || false;
        applyViewRotation();
        
        startBackgroundRotationScanner(); // Iniciar auto-rotación constante
        
        resolve();
      };
    });
  } catch (err) {
    // Si aún así falla, es posible que estemos en HTTP en vez de HTTPS, o el dispositivo no la soporta
    showToast("Error cámara: " + err.name, "error");
    console.error(err);
    if (err.name === 'NotAllowedError') {
      feedbackText.innerHTML = "<span class='text-danger'>Permiso de cámara denegado.</span>";
    } else if (err.name === 'OverconstrainedError') {
      feedbackText.innerHTML = "<span class='text-danger'>La cámara seleccionada no soporta esta resolución. Borra tu selección manual.</span>";
    } else {
      feedbackText.innerHTML = `<span class='text-danger'>Error: ${err.message || err.name}</span>`;
    }
  }
}

// ==========================================
// MAGIA: AUTO-ROTACIÓN EN SEGUNDO PLANO (MODO IDLE)
// ==========================================
function startBackgroundRotationScanner() {
  if (backgroundRotationInterval) clearInterval(backgroundRotationInterval);
  
  backgroundRotationInterval = setInterval(async () => {
    // Solo correr si la cámara está activa y estamos en el menú principal (idle)
    if (!camaraActiva || modoActual !== 'idle' || isScanning) return;
    
    try {
      const maxDim = 400;
      let scaleFactor = 1;
      if (video.videoWidth > maxDim || video.videoHeight > maxDim) {
        scaleFactor = maxDim / Math.max(video.videoWidth, video.videoHeight);
      }
      
      const scaledWidth = video.videoWidth * scaleFactor;
      const scaledHeight = video.videoHeight * scaleFactor;
      
      for (let angle of [0, 90, -90, 180]) {
        if (modoActual !== 'idle' || isScanning) break; // Abortar si el usuario presionó algún botón
        
        offscreenCanvas.width = angle === 90 || angle === -90 ? scaledHeight : scaledWidth;
        offscreenCanvas.height = angle === 90 || angle === -90 ? scaledWidth : scaledHeight;
        
        offCtx.save();
        offCtx.translate(offscreenCanvas.width / 2, offscreenCanvas.height / 2);
        offCtx.rotate((angle * Math.PI) / 180);
        offCtx.scale(scaleFactor, scaleFactor);
        
        // Recorte interno (Zoom y Desplazamiento) para que la IA vea lo mismo que el usuario
        const sw = video.videoWidth / currentZoom;
        const sh = video.videoHeight / currentZoom;
        const visualRatioX = video.videoWidth / videoWrapper.offsetWidth;
        const visualRatioY = video.videoHeight / videoWrapper.offsetHeight;
        const sx = (video.videoWidth - sw) / 2 - (panX * visualRatioX);
        const sy = (video.videoHeight - sh) / 2 - (panY * visualRatioY);
        
        offCtx.drawImage(video, sx, sy, sw, sh, -video.videoWidth / 2, -video.videoHeight / 2, video.videoWidth, video.videoHeight);
        offCtx.restore();
        
        // Threshold más bajo (0.5) porque aquí solo nos interesa saber en qué ángulo está la cabeza
        const options = new faceapi.TinyFaceDetectorOptions({ inputSize: 320, scoreThreshold: 0.5 });
        const detection = await faceapi.detectSingleFace(offscreenCanvas, options);
        if (detection) {
          const normalizedAngle = ((angle % 360) + 360) % 360;
          const normalizedView = ((viewRotation % 360) + 360) % 360;
          
          if (normalizedAngle !== normalizedView && currentZoom === 1 && isAutoRotateEnabled) {
            viewRotation = getClosestRotation(viewRotation, normalizedAngle);
            const camKey = currentCameraId || currentFacingMode;
            cameraRotations[camKey] = viewRotation;
            localStorage.setItem('cameraRotations', JSON.stringify(cameraRotations));
            applyViewRotation();
          }
          break; // Si encontró el rostro, no buscar más ángulos por este ciclo
        }
      }
    } catch (e) {}
  }, 2500); // Revisar cada 2.5 segundos
}

function stopCamera() {
  if (!camaraActiva) return;
  const stream = video.srcObject;
  if (stream) {
    stream.getTracks().forEach(track => track.stop());
  }
  video.srcObject = null;
  camaraActiva = false;
  if (scanInterval) clearInterval(scanInterval);
  if (scanQRInterval) clearInterval(scanQRInterval);
  
  const ctx = canvas.getContext('2d');
  ctx.clearRect(0, 0, canvas.width, canvas.height);
}

// ==========================================
// FLUJO DE REGISTRO
// ==========================================
btnRegister.addEventListener('click', async () => {
  // Si estamos en validación, este botón actúa como "Cancelar"
  if (modoActual === 'validacion') {
    showToast("Validación cancelada", "warning");
    detenerProcesos();
    return;
  }

  // Prevenir dobles clics
  if (modoActual === 'registro') return;

  modoActual = 'registro';
  appState.textContent = 'Modo: Registro de Estudiante';
  capturasRegistro = [];
  qrDataTemporal = null;
  
  // Cambiar botones UI
  btnLogin.innerHTML = `<span class="icon">🚫</span> Cancelar`;
  btnRegister.innerHTML = `<span class="icon">⏳</span> Registrando...`;
  
  await startCamera();
  videoWrapper.classList.add('scanning');
  
  feedbackText.innerHTML = "Paso 1: Muestre su Carnet (QR) o escriba el código";
  manualCodeContainer.classList.remove('hidden');
  
  startQRScanner(onQRRegistered);
  
  // Timeout de 30 segundos para leer el QR
  iniciarTemporizador(30);
});

function iniciarTemporizador(segundos) {
  if (actionTimeout) clearTimeout(actionTimeout);
  actionTimeout = setTimeout(() => {
    if (modoActual !== 'idle') {
      showToast(`Tiempo de espera agotado (${segundos}s). Operación cancelada.`, "error");
      detenerProcesos();
    }
  }, segundos * 1000);
}

function onQRRegistered(decodedText) {
  if (!decodedText || decodedText.trim().length < 3) return; // Evitar falsos positivos
  
  const existe = dbEstudiantes.some(e => e.qr === decodedText);
  if (existe) {
    const now = Date.now();
    if (now - lastQRErrorTime > 10000) { // 10 segundos
      showToast("⚠️ Este código/QR ya está registrado.", "warning");
      lastQRErrorTime = now;
    }
    return;
  }
  
  qrDataTemporal = decodedText;
  showToast(`Código Leído: ${decodedText}`, "success");
  
  clearInterval(scanQRInterval); // Detener QR
  manualCodeContainer.classList.add('hidden'); // Ocultar input manual
  
  feedbackText.innerHTML = "Paso 2: Mire a la cámara para guardar su rostro";
  
  // Mostrar la guía visual del rostro
  faceGuide.classList.add('active');
  faceGuide.classList.remove('success');
  
  // Reiniciar temporizador: dar 90 segundos para capturar el rostro
  iniciarTemporizador(90);
  
  iniciarEscaneoFacial(registrarRostro);
}

async function registrarRostro(detection, faceDescriptor) {
  const box = detection.detection.box;
  const faceWidth = box.width;
  // Ajustado para que las guías de "Acércate" o "Aléjate" sigan funcionando bien
  const minW = video.videoWidth * 0.18;
  const maxW = video.videoWidth * 0.65;
  
  if (faceWidth < minW) {
    feedbackText.innerHTML = "<span class='text-warning'>⚠️ Acércate un poco más</span>";
    faceGuide.classList.remove('success');
    return;
  }
  if (faceWidth > maxW) {
    feedbackText.innerHTML = "<span class='text-warning'>⚠️ Aléjate un poco</span>";
    faceGuide.classList.remove('success');
    return;
  }
  
  feedbackText.innerHTML = "<span class='text-success'>✅ Posición perfecta. Capturando...</span>";
  faceGuide.classList.add('success');
  capturasRegistro.push(faceDescriptor);
  
  if (capturasRegistro.length >= 3) {
    if (scanInterval) clearInterval(scanInterval);
    
    // Calcular el promedio de las 3 capturas para crear una firma facial mucho más robusta
    const meanDescriptor = new Float32Array(128);
    for (let i = 0; i < 128; i++) {
      let sum = 0;
      for (let j = 0; j < capturasRegistro.length; j++) {
        sum += capturasRegistro[j][i];
      }
      meanDescriptor[i] = sum / capturasRegistro.length;
    }
    
    const newStudent = {
      nombre: `Estudiante_${qrDataTemporal}`,
      qr: qrDataTemporal,
      descriptor: Array.from(meanDescriptor),
      timestamp: new Date().toISOString()
    };
    
    dbEstudiantes.push(newStudent);
    localStorage.setItem('estudiantes', JSON.stringify(dbEstudiantes));
    
    if (typeof renderTable === 'function') renderTable();
    
    showToast(`¡Estudiante Registrado con Éxito!`, "success");
    detenerProcesos();
  } else {
    showToast(`Captura ${capturasRegistro.length}/3`, "warning");
    await new Promise(r => setTimeout(r, 1000));
  }
}

// ==========================================
// FLUJO DE INGRESO (VALIDACIÓN)
// ==========================================
btnLogin.addEventListener('click', async () => {
  // Si estamos en registro, este botón actúa como "Cancelar"
  if (modoActual === 'registro') {
    showToast("Registro cancelado", "warning");
    detenerProcesos();
    return;
  }

  // Prevenir dobles clics
  if (modoActual === 'validacion') return;

  if (dbEstudiantes.length === 0) {
    showToast("La base de datos está vacía. Regístrese primero.", "error");
    return;
  }
  
  modoActual = 'validacion';
  appState.textContent = 'Modo: Validación Activa (QR o Rostro)';
  
  // Cambiar botones UI
  btnRegister.innerHTML = `<span class="icon">🚫</span> Cancelar`;
  btnLogin.innerHTML = `<span class="icon">⏳</span> Validando...`;
  
  await startCamera();
  videoWrapper.classList.add('scanning');
  feedbackText.innerHTML = "Presente su Carnet o mire a la cámara";
  
  // En validación, mostrar la guía del rostro de una vez
  faceGuide.classList.add('active');
  faceGuide.classList.remove('success');
  manualCodeContainer.classList.add('hidden'); // Asegurarnos de que el input manual esté oculto
  
  // Precalcular el FaceMatcher UNA SOLA VEZ para no congelar el navegador
  if (dbEstudiantes.length > 0) {
    const labeledDescriptors = dbEstudiantes.map(est => {
      return new faceapi.LabeledFaceDescriptors(est.nombre, [new Float32Array(est.descriptor)]);
    });
    // 0.45 es mucho más estricto que 0.60. Evita falsos positivos.
    currentFaceMatcher = new faceapi.FaceMatcher(labeledDescriptors, 0.45);
  } else {
    currentFaceMatcher = null;
  }
  
  startQRScanner(onQRValidated);
  iniciarEscaneoFacial(validarRostro);
  
  // Timeout de 60 segundos para el log in general
  iniciarTemporizador(60);
});

function onQRValidated(decodedText) {
  if (!decodedText || decodedText.trim().length < 3) return; // Evitar falsos positivos
  
  const estudiante = dbEstudiantes.find(e => e.qr === decodedText);
  if (estudiante) {
    registrarIngreso(estudiante);
    showToast(`✅ ¡INGRESO EXITOSO: ${estudiante.nombre}! (Por Carnet)`, "success");
    detenerProcesos();
  } else {
    const now = Date.now();
    if (now - lastQRErrorTime > 10000) { // 10 segundos
      showToast(`❌ QR No Registrado`, "error");
      lastQRErrorTime = now;
    }
  }
}

async function validarRostro(detection, faceDescriptor) {
  if (!currentFaceMatcher) return;
  
  const box = detection.detection.box;
  const faceWidth = box.width;
  if (faceWidth < video.videoWidth * 0.15) {
    feedbackText.innerHTML = "<span class='text-warning'>⚠️ Acércate más</span>";
    return;
  }
  
  feedbackText.innerHTML = "Analizando Rostro...";
  
  const bestMatch = currentFaceMatcher.findBestMatch(faceDescriptor);
  
  if (bestMatch.label !== 'unknown') {
    const estudiante = dbEstudiantes.find(e => e.nombre === bestMatch.label);
    if (estudiante) registrarIngreso(estudiante);
    showToast(`✅ ¡INGRESO EXITOSO: ${bestMatch.label}! (Por Rostro)`, "success");
    detenerProcesos();
  } else {
    feedbackText.innerHTML = "<span class='text-danger'>❌ Rostro desconocido</span>";
  }
}

// ==========================================
// UTILIDADES: MOTOR IA y QR
// ==========================================
function iniciarEscaneoFacial(callback) {
  if (scanInterval) clearInterval(scanInterval);
  
  stopScanningFlag = false;
  if (isScanning) return;
  isScanning = true;
  lockedRotationAngle = null;
  lostFaceFrames = 0;
  
  // Usamos una función asíncrona autoejecutable para evitar solapamientos de frames (que causaban el lag de 20s)
  (async function loop() {
    while (!stopScanningFlag && camaraActiva && modoActual !== 'idle') {
      if (video.videoWidth === 0 || video.videoHeight === 0) {
        await new Promise(r => setTimeout(r, 100));
        continue;
      }
      
      // Si ya encontramos un rostro en un ángulo, nos quedamos en ese ángulo para no perder tiempo buscando en los demás
      let angle;
      if (lockedRotationAngle !== null) {
        angle = lockedRotationAngle;
      } else {
        angle = rotationAngles[currentRotationIdx];
        currentRotationIdx = (currentRotationIdx + 1) % rotationAngles.length;
      }
      
      let isRotated = angle !== 0;
      let detection;
      
      try {
        // OPTIMIZACIÓN MASIVA: Reducir la resolución interna a máximo 400px antes de pasarla a la IA
        // Esto acelera la detección x10 en dispositivos móviles sin afectar la calidad de la IA
        const maxDim = 400;
        let scaleFactor = 1;
        if (video.videoWidth > maxDim || video.videoHeight > maxDim) {
          scaleFactor = maxDim / Math.max(video.videoWidth, video.videoHeight);
        }
        
        const scaledWidth = video.videoWidth * scaleFactor;
        const scaledHeight = video.videoHeight * scaleFactor;
        
        offscreenCanvas.width = angle === 90 || angle === -90 ? scaledHeight : scaledWidth;
        offscreenCanvas.height = angle === 90 || angle === -90 ? scaledWidth : scaledHeight;
        
        offCtx.save();
        offCtx.translate(offscreenCanvas.width / 2, offscreenCanvas.height / 2);
        offCtx.rotate((angle * Math.PI) / 180);
        offCtx.scale(scaleFactor, scaleFactor);
        
        // Aplicar recorte interno (Zoom Óptico y Desplazamiento para la IA)
        const sw = video.videoWidth / currentZoom;
        const sh = video.videoHeight / currentZoom;
        const visualRatioX = video.videoWidth / videoWrapper.offsetWidth;
        const visualRatioY = video.videoHeight / videoWrapper.offsetHeight;
        const sx = (video.videoWidth - sw) / 2 - (panX * visualRatioX);
        const sy = (video.videoHeight - sh) / 2 - (panY * visualRatioY);
        
        offCtx.drawImage(video, sx, sy, sw, sh, -video.videoWidth / 2, -video.videoHeight / 2, video.videoWidth, video.videoHeight);
        offCtx.restore();
        
        // Ejecutar inferencia usando el modelo ultra-rápido (reducido a 0.65 para evitar fallos en móviles con cámaras menos nítidas o iluminación pobre)
        const options = new faceapi.TinyFaceDetectorOptions({ inputSize: 320, scoreThreshold: 0.65 });
        detection = await faceapi.detectSingleFace(offscreenCanvas, options).withFaceLandmarks().withFaceDescriptor();
        
        if (detection) {
          // Escalar el resultado devuelta al tamaño original para que las matemáticas del callback funcionen
          const unscaledSize = { 
            width: offscreenCanvas.width / scaleFactor, 
            height: offscreenCanvas.height / scaleFactor 
          };
          detection = faceapi.resizeResults(detection, unscaledSize);
        }
      } catch (e) {
        console.error(e);
      }
      
      if (stopScanningFlag || modoActual === 'idle') break;
      
      if (detection) {
        lockedRotationAngle = angle; // Fijar este ángulo
        lostFaceFrames = 0;
        
        // ¡MAGIA! Auto-rotación visual inteligente
        const normalizedAngle = ((angle % 360) + 360) % 360;
        const normalizedView = ((viewRotation % 360) + 360) % 360;
        if (normalizedAngle !== normalizedView && currentZoom === 1 && isAutoRotateEnabled) {
          viewRotation = getClosestRotation(viewRotation, normalizedAngle);
          // Guardar en caché
          const camKey = currentCameraId || currentFacingMode;
          cameraRotations[camKey] = viewRotation;
          localStorage.setItem('cameraRotations', JSON.stringify(cameraRotations));
          applyViewRotation();
        }
        
        const displaySize = { width: video.videoWidth, height: video.videoHeight };
        faceapi.matchDimensions(canvas, displaySize);
        
        if (!isRotated) {
          const ctx = canvas.getContext('2d');
          ctx.clearRect(0, 0, canvas.width, canvas.height);
          
          ctx.save();
          // Ajustar las coordenadas de la caja azul para que encajen con el zoom visual
          const sw_c = canvas.width / currentZoom;
          const sh_c = canvas.height / currentZoom;
          const sx_c = (canvas.width - sw_c) / 2;
          const sy_c = (canvas.height - sh_c) / 2;
          
          ctx.translate(sx_c, sy_c);
          ctx.scale(1 / currentZoom, 1 / currentZoom);
          
          faceapi.draw.drawDetections(canvas, detection);
          ctx.restore();
        }
        
        await callback(detection, detection.descriptor);
      } else {
        lostFaceFrames++;
        if (lostFaceFrames > 2) {
          lockedRotationAngle = null; // Volver a buscar en otros ángulos si perdemos el rostro
        }
        if (!isRotated) {
          const ctx = canvas.getContext('2d');
          ctx.clearRect(0, 0, canvas.width, canvas.height);
        }
      }
      
      // Pequeña pausa para no bloquear la interfaz gráfica del navegador
      await new Promise(r => setTimeout(r, 50));
    }
    isScanning = false;
  })();
}

function startQRScanner(onSuccess) {
  if (scanQRInterval) clearInterval(scanQRInterval);
  
  const tempCanvas = document.createElement('canvas');
  const ctx = tempCanvas.getContext('2d', { willReadFrequently: true });
  
  scanQRInterval = setInterval(() => {
    if (!camaraActiva || video.paused || video.ended) return;
    
    tempCanvas.width = video.videoWidth;
    tempCanvas.height = video.videoHeight;
    
    // Zoom interno y desplazamiento para el lector QR
    const sw = video.videoWidth / currentZoom;
    const sh = video.videoHeight / currentZoom;
    const visualRatioX = video.videoWidth / videoWrapper.offsetWidth;
    const visualRatioY = video.videoHeight / videoWrapper.offsetHeight;
    const sx = (video.videoWidth - sw) / 2 - (panX * visualRatioX);
    const sy = (video.videoHeight - sh) / 2 - (panY * visualRatioY);
    
    ctx.drawImage(video, sx, sy, sw, sh, 0, 0, tempCanvas.width, tempCanvas.height);
    
    const imageData = ctx.getImageData(0, 0, tempCanvas.width, tempCanvas.height);
    const code = jsQR(imageData.data, imageData.width, imageData.height, {
      inversionAttempts: "dontInvert",
    });
    
    if (code) {
      onSuccess(code.data);
    }
  }, 300); // 3 veces por segundo
}

function detenerProcesos() {
  stopScanningFlag = true;
  if (scanInterval) clearInterval(scanInterval);
  if (scanQRInterval) clearInterval(scanQRInterval);
  if (actionTimeout) clearTimeout(actionTimeout);
  
  videoWrapper.classList.remove('scanning');
  faceGuide.classList.remove('active', 'success');
  manualCodeContainer.classList.add('hidden');
  modoActual = 'idle';
  appState.textContent = 'Listo para operar';
  
  // Restaurar botones a su estado original
  btnRegister.innerHTML = `<span class="icon">➕</span> Registrarse`;
  btnLogin.innerHTML = `<span class="icon">🔓</span> Ingresar`;
  
  // Limpiar el texto, pero la cámara sigue encendida
  feedbackText.innerHTML = "Cámara activa. Seleccione una acción.";
  
  // Limpiamos los rectángulos del canvas
  const ctx = canvas.getContext('2d');
  ctx.clearRect(0, 0, canvas.width, canvas.height);
}

// ==========================================
// ALTERNAR CÁMARA (FLIP)
// ==========================================
btnFlipCamera.addEventListener('click', async () => {
  if (!camaraActiva) return; // Solo voltear si la cámara está encendida
  
  // Cambiar el modo
  currentFacingMode = currentFacingMode === 'user' ? 'environment' : 'user';
  
  // Borrar la cámara seleccionada manualmente para que haga caso al facingMode
  currentCameraId = null;
  localStorage.removeItem('selectedCameraId');
  
  // Reiniciar solo la cámara de manera suave
  const stream = video.srcObject;
  if (stream) stream.getTracks().forEach(track => track.stop());
  camaraActiva = false;
  
  showToast("Cambiando cámara...", "warning");
  await startCamera();
});

// ==========================================
// CONTROL DE VISTA (ROTAR CAMARA Y ZOOM/PAN)
// ==========================================
function applyViewRotation() {
  let scale = 1;
  const normalizedRotation = ((viewRotation % 360) + 360) % 360;
  if (normalizedRotation === 90 || normalizedRotation === 270) {
    if (video.videoHeight > 0) {
      const ratio = video.videoWidth / video.videoHeight;
      scale = Math.max(ratio, 1/ratio);
    }
  }
  
  scale *= currentZoom;
  
  // Limitar el pan visual para que no se vea negro en los bordes
  if (currentZoom === 1) {
    panX = 0; panY = 0;
  }
  
  const scaleX = isMirrored ? -scale : scale;
  const transformStyle = `translate(${panX}px, ${panY}px) rotate(${viewRotation}deg) scaleX(${scaleX}) scaleY(${scale})`;
  video.style.transform = transformStyle;
  canvas.style.transform = transformStyle;
  
  faceGuide.style.transform = `translate(-50%, -50%)`;
}

if (btnMirrorCamera) {
  btnMirrorCamera.addEventListener('click', () => {
    if (!camaraActiva) return;
    isMirrored = !isMirrored;
    const camKey = currentCameraId || currentFacingMode;
    cameraMirrors[camKey] = isMirrored;
    localStorage.setItem('cameraMirrors', JSON.stringify(cameraMirrors));
    
    video.style.transition = 'transform 0.3s ease';
    canvas.style.transition = 'transform 0.3s ease';
    
    applyViewRotation();
    
    setTimeout(() => {
      video.style.transition = 'none';
      canvas.style.transition = 'none';
    }, 300);
    
    showToast(isMirrored ? "Modo espejo activado" : "Modo espejo desactivado", "info");
  });
}

btnRotateView.addEventListener('click', () => {
  viewRotation += 90;
  
  // Guardar configuración en el caché
  const camKey = currentCameraId || currentFacingMode;
  cameraRotations[camKey] = ((viewRotation % 360) + 360) % 360;
  localStorage.setItem('cameraRotations', JSON.stringify(cameraRotations));
  
  // Añadir transición suave para el salto de rotación
  video.style.transition = 'transform 0.4s cubic-bezier(0.2, 0.8, 0.2, 1)';
  canvas.style.transition = 'transform 0.4s cubic-bezier(0.2, 0.8, 0.2, 1)';
  
  applyViewRotation();
  
  setTimeout(() => {
    video.style.transition = 'none';
    canvas.style.transition = 'none';
  }, 400);
});

zoomSlider.addEventListener('input', (e) => {
  currentZoom = parseFloat(e.target.value);
  const zoomText = Number.isInteger(currentZoom) ? currentZoom.toString() : currentZoom.toFixed(1);
  zoomLabel.innerHTML = `🔍 ${zoomText}x`;
  
  if (currentZoom === 1) {
    panX = 0; panY = 0;
  }
  applyViewRotation();
});

// Cuando el usuario hace clic en una parte de la barra (salto) o suelta el drag, suavizamos ese último frame
zoomSlider.addEventListener('change', () => {
  video.style.transition = 'transform 0.4s cubic-bezier(0.2, 0.8, 0.2, 1)';
  canvas.style.transition = 'transform 0.4s cubic-bezier(0.2, 0.8, 0.2, 1)';
  applyViewRotation();
  setTimeout(() => {
    video.style.transition = 'none';
    canvas.style.transition = 'none';
  }, 400);
});

// Eventos de Arrastre (Pan) y Gestos (Zoom)
let initialPinchDistance = null;
let initialPinchZoom = 1;
let lastTap = 0;

function getPinchDistance(e) {
  return Math.hypot(
    e.touches[0].clientX - e.touches[1].clientX,
    e.touches[0].clientY - e.touches[1].clientY
  );
}

function handleDoubleClick(e) {
  if (currentZoom > 1) {
    currentZoom = 1;
    panX = 0; panY = 0;
  } else {
    currentZoom = 3.5;
    
    // Calcular coordenadas del toque o clic
    const rect = videoWrapper.getBoundingClientRect();
    let clientX, clientY;
    
    if (e.type.includes('touch') && e.touches && e.touches.length > 0) {
      clientX = e.touches[0].clientX;
      clientY = e.touches[0].clientY;
    } else {
      clientX = e.clientX;
      clientY = e.clientY;
    }
    
    const offsetX = (clientX - rect.left) - (rect.width / 2);
    const offsetY = (clientY - rect.top) - (rect.height / 2);
    
    // Trasladar el punto clickeado al centro de la pantalla
    panX = -offsetX * currentZoom;
    panY = -offsetY * currentZoom;
    
    // Limitar el paneo para no salirnos de los bordes
    const maxPanX = (rect.width * currentZoom - rect.width) / 2;
    const maxPanY = (rect.height * currentZoom - rect.height) / 2;
    
    panX = Math.max(-maxPanX, Math.min(maxPanX, panX));
    panY = Math.max(-maxPanY, Math.min(maxPanY, panY));
  }
  
  zoomSlider.value = currentZoom;
  const zoomText = Number.isInteger(currentZoom) ? currentZoom.toString() : currentZoom.toFixed(1);
  zoomLabel.innerHTML = `🔍 ${zoomText}x`;
  
  // Añadir transición suave SOLO para este salto
  video.style.transition = 'transform 0.4s cubic-bezier(0.2, 0.8, 0.2, 1)';
  canvas.style.transition = 'transform 0.4s cubic-bezier(0.2, 0.8, 0.2, 1)';
  
  applyViewRotation();
  
  // Quitar la transición después de la animación para no afectar el drag
  setTimeout(() => {
    video.style.transition = 'none';
    canvas.style.transition = 'none';
  }, 400);
}

videoWrapper.addEventListener('dblclick', (e) => {
  if (e.target.tagName === 'INPUT' || e.target.tagName === 'BUTTON' || e.target.closest('button') || e.target.closest('.drawer')) return;
  handleDoubleClick(e);
});

function startDrag(e) {
  if (e.target.tagName === 'INPUT' || e.target.tagName === 'BUTTON' || e.target.closest('button') || e.target.closest('.drawer')) return;
  
  if (e.type === 'touchstart') {
    const currentTime = new Date().getTime();
    const tapLength = currentTime - lastTap;
    if (tapLength < 300 && tapLength > 0 && e.touches.length === 1) {
      handleDoubleClick(e);
      e.preventDefault();
      return;
    }
    lastTap = currentTime;
  }
  
  if (e.touches && e.touches.length === 2) {
    isDragging = false;
    initialPinchDistance = getPinchDistance(e);
    initialPinchZoom = currentZoom;
    return;
  }

  if (currentZoom <= 1) return;
  
  isDragging = true;
  startX = e.type.includes('mouse') ? e.clientX : e.touches[0].clientX;
  startY = e.type.includes('mouse') ? e.clientY : e.touches[0].clientY;
  startPanX = panX;
  startPanY = panY;
}

function doDrag(e) {
  if (e.touches && e.touches.length === 2) {
    e.preventDefault();
    if (initialPinchDistance) {
      const currentDistance = getPinchDistance(e);
      const scaleChange = currentDistance / initialPinchDistance;
      let newZoom = initialPinchZoom * scaleChange;
      
      newZoom = Math.max(parseFloat(zoomSlider.min), Math.min(parseFloat(zoomSlider.max), newZoom));
      
      currentZoom = newZoom;
      zoomSlider.value = currentZoom;
      const zoomText = Number.isInteger(currentZoom) ? currentZoom.toString() : currentZoom.toFixed(1);
      zoomLabel.innerHTML = `🔍 ${zoomText}x`;
      
      if (currentZoom === 1) {
        panX = 0; panY = 0;
      }
      applyViewRotation();
    }
    return;
  }

  if (!isDragging) return;
  e.preventDefault();
  const currentX = e.type.includes('mouse') ? e.clientX : e.touches[0].clientX;
  const currentY = e.type.includes('mouse') ? e.clientY : e.touches[0].clientY;
  
  const maxPanX = (videoWrapper.offsetWidth * currentZoom - videoWrapper.offsetWidth) / 2;
  const maxPanY = (videoWrapper.offsetHeight * currentZoom - videoWrapper.offsetHeight) / 2;

  panX = startPanX + (currentX - startX);
  panY = startPanY + (currentY - startY);
  
  panX = Math.max(-maxPanX, Math.min(maxPanX, panX));
  panY = Math.max(-maxPanY, Math.min(maxPanY, panY));
  
  applyViewRotation();
}

function endDrag() {
  isDragging = false;
  initialPinchDistance = null;
}

videoWrapper.addEventListener('mousedown', startDrag);
videoWrapper.addEventListener('mousemove', doDrag);
window.addEventListener('mouseup', endDrag);

videoWrapper.addEventListener('touchstart', startDrag, { passive: false });
videoWrapper.addEventListener('touchmove', doDrag, { passive: false });
window.addEventListener('touchend', endDrag);

// ==========================================
// CONFIGURACIÓN DE CÁMARA (AJUSTES)
// ==========================================
btnSettings.addEventListener('click', async () => {
  cameraModal.classList.remove('hidden');
  cameraSelect.innerHTML = '<option value="">Cargando cámaras...</option>';
  
  try {
    const devices = await navigator.mediaDevices.enumerateDevices();
    const videoDevices = devices.filter(device => device.kind === 'videoinput');
    
    cameraSelect.innerHTML = '';
    if (videoDevices.length === 0) {
      cameraSelect.innerHTML = '<option value="">No se encontraron cámaras</option>';
      return;
    }
    
    videoDevices.forEach((device, index) => {
      const option = document.createElement('option');
      option.value = device.deviceId;
      option.text = device.label || `Cámara ${index + 1}`;
      if (device.deviceId === currentCameraId) {
        option.selected = true;
      }
      cameraSelect.appendChild(option);
    });
  } catch (err) {
    console.error("Error listando cámaras:", err);
    cameraSelect.innerHTML = '<option value="">Error al cargar cámaras</option>';
  }
});

// ==========================================
// EVENTOS PARA INPUT MANUAL
// ==========================================
btnSubmitCode.addEventListener('click', () => {
  const codigo = manualCodeInput.value.trim();
  if (codigo.length > 0) {
    if (confirm(`Por favor verifique su código:\n\n¿Es "${codigo}" correcto?`)) {
      onQRRegistered(codigo);
      manualCodeInput.value = '';
    }
  } else {
    showToast("Escriba un código válido", "warning");
  }
});
manualCodeInput.addEventListener('keypress', (e) => {
  if (e.key === 'Enter') btnSubmitCode.click();
});

cameraSelect.addEventListener('change', async () => {
  const selectedId = cameraSelect.value;
  if (selectedId) {
    currentCameraId = selectedId;
    localStorage.setItem('selectedCameraId', selectedId);
    
    // Reiniciar cámara con la nueva selección inmediatamente
    if (camaraActiva) {
      stopCamera();
      showToast("Cambiando cámara...", "warning");
      await startCamera();
    }
  }
});

btnCloseModal.addEventListener('click', () => {
  cameraModal.classList.add('hidden');
});

btnClearDB.addEventListener('click', () => {
  if (confirm("¿Estás seguro de que quieres borrar TODOS los estudiantes y el historial de ingresos? Esta acción no se puede deshacer.")) {
    dbEstudiantes = [];
    dbIngresos = [];
    localStorage.removeItem('estudiantes');
    localStorage.removeItem('ingresos');
    if (typeof renderTable === 'function') renderTable();
    showToast("Base de datos eliminada", "success");
    cameraModal.classList.add('hidden');
  }
});

// ==========================================
// SISTEMA DE ALERTAS (TOASTS)
// ==========================================
function showToast(message, type = 'success') {
  const container = document.getElementById('toastContainer');
  const toast = document.createElement('div');
  toast.className = `toast ${type}`;
  
  toast.innerHTML = `<span>${message}</span>`;
  container.appendChild(toast);
  
  setTimeout(() => toast.remove(), 3500);
}

// ==========================================
// REGISTRO DE INGRESOS
// ==========================================
function registrarIngreso(estudiante) {
  const ingreso = {
    nombre: estudiante.nombre,
    qr: estudiante.qr,
    timestamp: new Date().toISOString()
  };
  dbIngresos.push(ingreso);
  localStorage.setItem('ingresos', JSON.stringify(dbIngresos));
  if (typeof renderTable === 'function') renderTable();
}

// ==========================================
// TABLA DE REGISTROS (INGRESOS)
// ==========================================
window.renderTable = function() {
  const tbody = document.getElementById('recordsTableBody');
  if (!tbody) return;
  
  tbody.innerHTML = '';
  
  // Ordenar ingresos de más reciente a más antiguo
  const sortedIngresos = [...dbIngresos].sort((a, b) => {
    const timeA = a.timestamp ? new Date(a.timestamp).getTime() : 0;
    const timeB = b.timestamp ? new Date(b.timestamp).getTime() : 0;
    return timeB - timeA;
  });
  
  // Obtener filtros unificados
  const searchNameInput = document.getElementById('searchName');
  const searchCodeInput = document.getElementById('searchCode');
  const filterStartInput = document.getElementById('filterStart');
  const filterEndInput = document.getElementById('filterEnd');
  
  const sName = searchNameInput ? searchNameInput.value.toLowerCase() : '';
  const sCode = searchCodeInput ? searchCodeInput.value.toLowerCase() : '';
  const fStart = filterStartInput && filterStartInput.value ? new Date(filterStartInput.value).getTime() : null;
  const fEnd = filterEndInput && filterEndInput.value ? new Date(filterEndInput.value).getTime() : null;

  let totalEncontrados = 0;

  sortedIngresos.forEach(ingreso => {
    let dateStr = 'Sin fecha';
    let ingresoTime = 0;
    
    if (ingreso.timestamp) {
      const d = new Date(ingreso.timestamp);
      dateStr = d.toLocaleString();
      ingresoTime = d.getTime();
    }
    
    const code = ingreso.qr || '';
    const name = ingreso.nombre || '';
    
    // Aplicar filtros de fecha y hora según el modo seleccionado
    const dateModeRadios = document.getElementsByName('dateMode');
    let selectedMode = 'all';
    for (const radio of dateModeRadios) {
      if (radio.checked) {
        selectedMode = radio.value;
        break;
      }
    }
    
    if (selectedMode === 'today') {
      const startOfToday = new Date();
      startOfToday.setHours(0, 0, 0, 0);
      const endOfToday = new Date();
      endOfToday.setHours(23, 59, 59, 999);
      if (ingresoTime < startOfToday.getTime() || ingresoTime > endOfToday.getTime()) return;
    } 
    else if (selectedMode === 'custom') {
      if (fStart || fEnd) {
        if (fStart && !fEnd) {
          // Lógica especial: Si solo hay "Desde", filtramos desde esa hora hasta el final de ESE MISMO DÍA
          const startObj = new Date(fStart);
          const endOfDay = new Date(startObj);
          endOfDay.setHours(23, 59, 59, 999);
          if (ingresoTime < fStart || ingresoTime > endOfDay.getTime()) return;
        } else {
          // Lógica de rango completo
          if (fStart && ingresoTime < fStart) return;
          if (fEnd && ingresoTime > fEnd) return;
        }
      }
    }
    
    if (sName) {
      if (!name.toLowerCase().includes(sName)) return;
    }
    
    if (sCode) {
      if (!code.toLowerCase().startsWith(sCode)) return;
    }
    
    totalEncontrados++;
    
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td>${dateStr}</td>
      <td>${name}</td>
      <td>${code}</td>
    `;
    tbody.appendChild(tr);
  });

  const recordCounter = document.getElementById('recordCounter');
  if (recordCounter) {
    if (sName || sCode || document.querySelector('input[name="dateMode"]:checked')?.value !== 'all') {
      recordCounter.textContent = `Ingresos totales: ${dbIngresos.length} | Filtrados: ${totalEncontrados}`;
    } else {
      recordCounter.textContent = `Ingresos totales: ${dbIngresos.length}`;
    }
  }
}

const searchNameEl = document.getElementById('searchName');
const searchCodeEl = document.getElementById('searchCode');
const fStartEl = document.getElementById('filterStart');
const fEndEl = document.getElementById('filterEnd');
const btnClear = document.getElementById('btnClearFilters');
const btnToggleFilters = document.getElementById('btnToggleFilters');
const filterPanel = document.getElementById('filterPanel');
const customDateInputs = document.getElementById('customDateInputs');
const dateModeRadios = document.getElementsByName('dateMode');

// Helper para bloquear fechas futuras
function setMaxDateInputs() {
  const now = new Date();
  const tzOffset = now.getTimezoneOffset() * 60000;
  const localISOTime = (new Date(now - tzOffset)).toISOString().slice(0, 16);
  if(fStartEl) fStartEl.max = localISOTime;
  if(fEndEl) fEndEl.max = localISOTime;
}

setMaxDateInputs();
setInterval(setMaxDateInputs, 60000); // Update max date every minute

// Alternar panel de filtros
if (btnToggleFilters && filterPanel) {
  btnToggleFilters.addEventListener('click', () => {
    filterPanel.classList.toggle('hidden');
    setMaxDateInputs(); // Ensure max date is up to date when opened
  });
}

// Escuchar cambios en los modos de fecha
dateModeRadios.forEach(radio => {
  radio.addEventListener('change', (e) => {
    if (e.target.value === 'custom') {
      customDateInputs.classList.remove('hidden');
    } else {
      customDateInputs.classList.add('hidden');
    }
    renderTable();
  });
});

if(searchNameEl) {
  searchNameEl.addEventListener('input', renderTable);
  searchNameEl.addEventListener('keyup', renderTable);
}

if(searchCodeEl) {
  searchCodeEl.addEventListener('input', renderTable);
  searchCodeEl.addEventListener('keyup', renderTable);
}

if(fStartEl) fStartEl.addEventListener('change', renderTable);
if(fEndEl) fEndEl.addEventListener('change', renderTable);

if (btnClear) {
  btnClear.addEventListener('click', () => {
    if (searchNameEl) searchNameEl.value = '';
    if (searchCodeEl) searchCodeEl.value = '';
    if (fStartEl) fStartEl.value = '';
    if (fEndEl) fEndEl.value = '';
    // Restaurar radio button a 'all'
    const defaultRadio = Array.from(dateModeRadios).find(r => r.value === 'all');
    if (defaultRadio) {
      defaultRadio.checked = true;
      customDateInputs.classList.add('hidden');
    }
    renderTable();
  });
}

renderTable();

// ==========================================
// SISTEMA DE TOUR INTERACTIVO (GLASSMORPHISM)
// ==========================================
class InteractiveTour {
  constructor() {
    this.steps = [
      {
        selector: '.video-wrapper',
        text: 'Esta es la cámara principal de la aplicación.',
        position: 'bottom'
      },
      {
        selector: '#zoomContainer',
        text: 'Aquí arriba tienes el control de <b>Zoom</b>. (También puedes pellizcar o hacer doble clic en el video).',
        position: 'bottom',
        onEnter: () => document.querySelector('.drawer-top').classList.add('open'),
        onLeave: () => document.querySelector('.drawer-top').classList.remove('open')
      },
      {
        selector: '.drawer-left .drawer-content',
        text: 'En la pestaña izquierda verás controles para <b>Girar 90°</b> o cambiar la <b>Orientación (Espejo)</b>, ideal si usas la cámara frontal.',
        position: 'right',
        onEnter: () => document.querySelector('.drawer-left').classList.add('open'),
        onLeave: () => document.querySelector('.drawer-left').classList.remove('open')
      },
      {
        selector: '#btnFlipCamera',
        text: 'En la pestaña derecha tienes el botón para <b>Voltear la cámara</b> (cambiar entre frontal y trasera en móviles).',
        position: 'left',
        onEnter: () => document.querySelector('.drawer-right').classList.add('open'),
        onLeave: () => document.querySelector('.drawer-right').classList.remove('open')
      },
      {
        selector: '#btnSettings',
        text: 'En <b>Ajustes</b> puedes cambiar manualmente la cámara a usar. Además, la aplicación cuenta con <b>Rotación Automática por IA</b> que girará la cámara sola si detecta que tu rostro está volteado.',
        position: 'bottom'
      },
      {
        selector: '#btnRegister',
        secondarySelector: '.video-wrapper',
        text: '<b>Registro:</b> Ubícate en el óvalo verde. Tienes <b>60s</b> para ingresar tu código, y <b>90s</b> para que la IA guarde tu rostro.',
        position: 'bottom',
        onEnter: () => document.getElementById('faceGuide').classList.add('active'),
        onLeave: () => document.getElementById('faceGuide').classList.remove('active')
      },
      {
        selector: '#btnLogin',
        secondarySelector: '.video-wrapper',
        text: '<b>Ingreso:</b> La IA escaneará tu rostro en el óvalo. Se cancelará en <b>30s</b> por inactividad.',
        position: 'bottom',
        onEnter: () => document.getElementById('faceGuide').classList.add('active'),
        onLeave: () => document.getElementById('faceGuide').classList.remove('active')
      },
      {
        selector: '#btnToggleFilters',
        text: 'Despliega este menú para buscar ingresos por nombre, código o fechas.',
        position: 'top'
      },
      {
        selector: '.table-responsive',
        text: 'Aquí aparecerá en tiempo real el historial de ingresos.',
        position: 'top'
      }
    ];
    this.currentStepIndex = 0;
    
    this.overlay = document.getElementById('tourOverlay');
    this.tooltip = document.getElementById('tourTooltip');
    this.textEl = document.getElementById('tourText');
    this.indicatorEl = document.getElementById('tourStepIndicator');
    this.btnNext = document.getElementById('btnTourNext');
    this.btnPrev = document.getElementById('btnTourPrev');
    this.btnSkip = document.getElementById('btnTourSkip');
    
    this.activeElement = null;

    if (!this.overlay || !this.tooltip) return;

    this.btnNext.addEventListener('click', () => this.nextStep());
    this.btnPrev.addEventListener('click', () => this.prevStep());
    this.btnSkip.addEventListener('click', () => this.endTour());
    
    // Check if it's the first visit
    if (!localStorage.getItem('tour_visto')) {
      setTimeout(() => this.startTour(), 1000); // Pequeño delay para que cargue la app
    }
  }

  startTour() {
    this.currentStepIndex = 0;
    this.overlay.classList.remove('hidden');
    this.tooltip.classList.remove('hidden');
    document.body.style.overflow = 'hidden'; // Evitar scroll manual durante el tour
    this.showStep();
  }

  endTour() {
    // Call onLeave for current step if exists
    if (this.steps[this.currentStepIndex] && this.steps[this.currentStepIndex].onLeave) {
      this.steps[this.currentStepIndex].onLeave();
    }
    
    this.overlay.classList.add('hidden');
    this.tooltip.classList.add('hidden');
    if (this.activeElement) {
      this.activeElement.classList.remove('tour-highlight');
      this.activeElement = null;
    }
    
    // Reset SVG mask holes just in case
    const hole1 = document.getElementById('tourHole1');
    const hole2 = document.getElementById('tourHole2');
    if (hole1) { hole1.setAttribute('width', '0'); hole1.setAttribute('height', '0'); }
    if (hole2) { hole2.setAttribute('width', '0'); hole2.setAttribute('height', '0'); }

    document.body.style.overflow = 'auto'; // Restaurar scroll
    localStorage.setItem('tour_visto', 'true');
  }

  showStep() {
    if (this.activeElement) {
      this.activeElement.classList.remove('tour-highlight');
      if (this.steps[this.currentStepIndex] && this.steps[this.currentStepIndex].secondarySelector) {
        const sec = document.querySelector(this.steps[this.currentStepIndex].secondarySelector);
        if (sec) sec.classList.remove('tour-highlight');
      }
    }

    const step = this.steps[this.currentStepIndex];
    
    if (step.onEnter) {
      step.onEnter();
    }
    
    // Fetch and scroll immediately so the animation happens during the timeout
    this.activeElement = document.querySelector(step.selector);
    if (!this.activeElement) {
      console.warn('Tour: Element not found:', step.selector);
      this.nextStep(); // Skip if missing
      return;
    }
    this.activeElement.scrollIntoView({ behavior: 'smooth', block: 'center' });
    
    // Esperar a que las animaciones css y el smooth scroll terminen
    setTimeout(() => {
      // Highlight
      this.activeElement.classList.add('tour-highlight');

      // Update Text
      this.textEl.innerHTML = step.text;
      this.indicatorEl.textContent = `Paso ${this.currentStepIndex + 1}/${this.steps.length}`;
      
      // Buttons state
      this.btnPrev.style.display = this.currentStepIndex === 0 ? 'none' : 'block';
      this.btnNext.textContent = this.currentStepIndex === this.steps.length - 1 ? 'Finalizar' : 'Siguiente';

      // Update SVG Mask
      const hole1 = document.getElementById('tourHole1');
      const hole2 = document.getElementById('tourHole2');
      
      if (hole1 && this.activeElement) {
        const rect = this.activeElement.getBoundingClientRect();
        hole1.setAttribute('x', rect.left - 5);
        hole1.setAttribute('y', rect.top - 5);
        hole1.setAttribute('width', rect.width + 10);
        hole1.setAttribute('height', rect.height + 10);
        
        const style = window.getComputedStyle(this.activeElement);
        let rx = style.borderRadius !== '0px' ? parseInt(style.borderRadius) : 8;
        if (isNaN(rx)) rx = 8;
        hole1.setAttribute('rx', rx);
        
        if (step.secondarySelector && hole2) {
          const secondary = document.querySelector(step.secondarySelector);
          if (secondary) {
            secondary.classList.add('tour-highlight');
            const rect2 = secondary.getBoundingClientRect();
            hole2.setAttribute('x', rect2.left - 5);
            hole2.setAttribute('y', rect2.top - 5);
            hole2.setAttribute('width', rect2.width + 10);
            hole2.setAttribute('height', rect2.height + 10);
            
            const style2 = window.getComputedStyle(secondary);
            let rx2 = style2.borderRadius !== '0px' ? parseInt(style2.borderRadius) : 8;
            if (isNaN(rx2)) rx2 = 8;
            hole2.setAttribute('rx', rx2);
          }
        } else if (hole2) {
          hole2.setAttribute('width', '0');
          hole2.setAttribute('height', '0');
        }
      }
      this.positionTooltip(step.position);
    }, 450); // 450ms asegura que el drawer o el scroll terminaron
  }

  positionTooltip(preferredPosition) {
    if (!this.activeElement) return;
    const rect = this.activeElement.getBoundingClientRect();
    const tooltipRect = this.tooltip.getBoundingClientRect();
    
    let top = 0;
    let left = rect.left + (rect.width / 2) - (tooltipRect.width / 2);

    // Evitar que se salga por los lados
    if (left < 10) left = 10;
    if (left + tooltipRect.width > window.innerWidth - 10) {
      left = window.innerWidth - tooltipRect.width - 10;
    }

    if (preferredPosition === 'bottom') {
      top = rect.bottom + 15;
      // Si se sale por abajo, ponerlo arriba
      if (top + tooltipRect.height > window.innerHeight) {
        top = rect.top - tooltipRect.height - 15;
      }
    } else {
      top = rect.top - tooltipRect.height - 15;
      // Si se sale por arriba, ponerlo abajo
      if (top < 10) {
        top = rect.bottom + 15;
      }
    }

    this.tooltip.style.top = `${top}px`;
    this.tooltip.style.left = `${left}px`;
  }

  nextStep() {
    if (this.steps[this.currentStepIndex] && this.steps[this.currentStepIndex].onLeave) {
      this.steps[this.currentStepIndex].onLeave();
    }
    
    if (this.currentStepIndex < this.steps.length - 1) {
      this.currentStepIndex++;
      this.showStep();
    } else {
      this.endTour();
    }
  }

  prevStep() {
    if (this.steps[this.currentStepIndex] && this.steps[this.currentStepIndex].onLeave) {
      this.steps[this.currentStepIndex].onLeave();
    }
    
    if (this.currentStepIndex > 0) {
      this.currentStepIndex--;
      this.showStep();
    }
  }
}

// Inicializar el tour cuando cargue la app
let appTour = null;
window.addEventListener('load', () => {
  initApp();
  appTour = new InteractiveTour();
  
  // Conectar botón de ayuda
  const btnHelp = document.getElementById('btnHelp');
  if (btnHelp) {
    btnHelp.addEventListener('click', () => {
      if (appTour) appTour.startTour();
    });
  }
});
