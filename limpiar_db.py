import os
import shutil

def limpiar_base_de_datos(db_name="antigravity.db"):
    print("="*40)
    print("🧹 LIMPIADOR DE BASE DE DATOS 🧹")
    print("="*40)
    
    if os.path.exists(db_name):
        try:
            os.remove(db_name)
            print(f"✅ ¡Éxito! El archivo '{db_name}' ha sido eliminado.")
            print("La próxima vez que ejecutes un script, la base de datos se creará desde cero y estará completamente vacía.")
        except Exception as e:
            print(f"❌ Error al intentar eliminar la base de datos: {e}")
            print("Asegúrate de que ningún otro programa (como main.py o registrar_camara.py) esté abierto usándola.")
    else:
        print(f"⚠️ La base de datos '{db_name}' ya estaba limpia (no existe).")
        
    if os.path.exists("fotos_registradas"):
        try:
            shutil.rmtree("fotos_registradas")
            print("✅ Carpeta 'fotos_registradas' y sus fotos eliminadas exitosamente.")
        except Exception as e:
            print(f"❌ Error al intentar eliminar fotos_registradas: {e}")
        
if __name__ == '__main__':
    limpiar_base_de_datos()
