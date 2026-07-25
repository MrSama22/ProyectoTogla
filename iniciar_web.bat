@echo off
echo ==========================================
echo    INICIANDO PROYECTO ANTIGRAVITY WEB
echo ==========================================
echo.
echo Iniciando servidor web local...
echo.

:: Navegar a la carpeta de la web app
cd webapp

:: Iniciar el servidor
echo (El servidor abrira la pagina web en tu navegador en unos segundos)
start http://localhost:5173

:: Iniciar el proceso de Vite
npm run dev

pause
