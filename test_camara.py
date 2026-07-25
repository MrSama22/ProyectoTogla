import cv2

def test_camera():
    # A veces DroidCam Cliente bloquea la conexión IP porque crea una "Cámara Virtual" en tu PC.
    # Vamos a intentar conectarnos a varias fuentes hasta que una funcione.
    fuentes_a_probar = [
        "http://192.168.1.37:4747/video", # Conexión IP directa al celular
         # Cámara virtual DroidCam 1
         # Cámara virtual DroidCam / Webcam principal
          # Otra cámara virtual
    ]
    
    cap = None
    fuente_exitosa = None
    
    for fuente in fuentes_a_probar:
        print(f"Probando conexión con: {fuente} ...")
        cap = cv2.VideoCapture(fuente)
        if cap.isOpened():
            fuente_exitosa = fuente
            break
            
    if not cap or not cap.isOpened():
        print("ERROR TOTAL: No se pudo conectar a ninguna cámara.")
        print("SOLUCIÓN: Si tienes el programa 'DroidCam Client' abierto en tu PC, ciérralo por completo y vuelve a intentar. El celular solo acepta 1 conexión a la vez.")
        return

    print(f"EXITO: Conectado usando la fuente: {fuente_exitosa}!")
    print("Presiona 'q' en la ventana del video para salir.")

    while True:
        ret, frame = cap.read()
        if not ret:
            print("ERROR: Se perdió la conexión con la cámara.")
            break

        # Mostrar el video en una ventana
        cv2.imshow('Test DroidCam', frame)

        # Salir si se presiona la tecla 'q'
        if cv2.waitKey(1) & 0xFF == ord('q'):
            break

    # Limpiar recursos
    cap.release()
    cv2.destroyAllWindows()

if __name__ == '__main__':
    test_camera()
