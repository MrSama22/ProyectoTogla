import * as faceapi from 'face-api.js';
import jsQR from 'jsqr';

// ==========================================
// ESTADO GLOBALES
// ==========================================
let modoActual = 'idle'; // 'idle', 'registro', 'validacion'
let dbEstudiantes = JSON.parse(localStorage.getItem('estudiantes')) || [];

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

// Control de vista
let cameraRotations = JSON.parse(localStorage.getItem('cameraRotations')) || {};
let viewRotation = 0;
let isAutoRotateEnabled = localStorage.getItem('autoRotateEnabled') !== 'false';

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
        
        // Cargar y aplicar rotación guardada para esta cámara
        const camKey = currentCameraId || currentFacingMode;
        viewRotation = cameraRotations[camKey] || 0;
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
            viewRotation = normalizedAngle;
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
  const minW = video.videoWidth * 0.15;
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
      descriptor: Array.from(meanDescriptor)
    };
    
    dbEstudiantes.push(newStudent);
    localStorage.setItem('estudiantes', JSON.stringify(dbEstudiantes));
    
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
        
        // Ejecutar inferencia usando el modelo ultra-rápido pero con 85% de exigencia para evitar alucinaciones
        const options = new faceapi.TinyFaceDetectorOptions({ inputSize: 320, scoreThreshold: 0.85 });
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
        const normalizedAngle = angle < 0 ? angle + 360 : angle;
        const normalizedView = viewRotation % 360;
        if (normalizedAngle !== normalizedView && currentZoom === 1 && isAutoRotateEnabled) {
          viewRotation = normalizedAngle;
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
  if (viewRotation === 90 || viewRotation === 270) {
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
  
  const transformStyle = `translate(${panX}px, ${panY}px) rotate(${viewRotation}deg) scale(${scale})`;
  video.style.transform = transformStyle;
  canvas.style.transform = transformStyle;
  
  faceGuide.style.transform = `translate(-50%, -50%)`;
}

btnRotateView.addEventListener('click', () => {
  viewRotation = (viewRotation + 90) % 360;
  
  // Guardar configuración en el caché para esta cámara en específico
  const camKey = currentCameraId || currentFacingMode;
  cameraRotations[camKey] = viewRotation;
  localStorage.setItem('cameraRotations', JSON.stringify(cameraRotations));
  
  applyViewRotation();
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

// Eventos de Arrastre (Pan)
function startDrag(e) {
  if (currentZoom <= 1) return;
  
  // No iniciar el arrastre si el usuario está tocando el slider de zoom, los botones o las pestañas de menú
  if (e.target.tagName === 'INPUT' || e.target.tagName === 'BUTTON' || e.target.closest('button') || e.target.closest('.drawer')) return;
  
  isDragging = true;
  startX = e.type.includes('mouse') ? e.clientX : e.touches[0].clientX;
  startY = e.type.includes('mouse') ? e.clientY : e.touches[0].clientY;
  startPanX = panX;
  startPanY = panY;
}

function doDrag(e) {
  if (!isDragging) return;
  e.preventDefault(); // Evitar scroll nativo en móviles
  const currentX = e.type.includes('mouse') ? e.clientX : e.touches[0].clientX;
  const currentY = e.type.includes('mouse') ? e.clientY : e.touches[0].clientY;
  
  // Calcular límites de arrastre basados en el zoom
  // (Asumiendo que a más zoom, más podemos arrastrar)
  const maxPanX = (videoWrapper.offsetWidth * currentZoom - videoWrapper.offsetWidth) / 2;
  const maxPanY = (videoWrapper.offsetHeight * currentZoom - videoWrapper.offsetHeight) / 2;

  panX = startPanX + (currentX - startX);
  panY = startPanY + (currentY - startY);
  
  // Limitar a los bordes visuales
  panX = Math.max(-maxPanX, Math.min(maxPanX, panX));
  panY = Math.max(-maxPanY, Math.min(maxPanY, panY));
  
  applyViewRotation();
}

function endDrag() {
  isDragging = false;
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
  if (confirm("¿Estás seguro de que quieres borrar TODOS los estudiantes registrados? Esta acción no se puede deshacer.")) {
    dbEstudiantes = [];
    localStorage.removeItem('estudiantes');
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
  
  let icon = '✅';
  if (type === 'error') icon = '❌';
  if (type === 'warning') icon = '⚠️';
  
  toast.innerHTML = `<span>${icon}</span> <span>${message}</span>`;
  container.appendChild(toast);
  
  setTimeout(() => toast.remove(), 3500);
}

window.addEventListener('load', initApp);
