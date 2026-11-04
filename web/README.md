# AulaLink: panel web de demostración

Frontend Next.js independiente de la API NestJS ubicada en la raíz del proyecto. La pantalla contiene datos ficticios y acciones locales del navegador; no se autentica, no consulta PostgreSQL y no envía solicitudes ni mensajes. No usar con información real.

## Probar localmente

Requiere Node.js 20.9 o posterior.

```powershell
Set-Location 'C:\xampp\htdocs\AulaLink\web'
npm ci
npm run dev
```

Abrir [http://localhost:3000](http://localhost:3000). Para verificar la versión de producción:

```powershell
npm run lint
npm run build
npm run start
```

## Subir este proyecto a un repositorio nuevo de GitHub

1. En GitHub, crear un repositorio vacío llamado `aulalink` (sin agregar README, licencia ni `.gitignore`).
2. Abrir PowerShell en `C:\xampp\htdocs\AulaLink`.
3. Inicializar un repositorio independiente para esta carpeta. Esto evita incluir por accidente archivos hermanos de `C:\xampp\htdocs`, que es el repositorio Git del directorio padre:

   ```powershell
   Set-Location 'C:\xampp\htdocs\AulaLink'
   git init -b main
   git add .
   git status --short
   ```

4. Antes de continuar, confirmar que no aparezcan `.env`, contraseñas, `node_modules` ni fotografías privadas en los archivos preparados. El `.gitignore` raíz excluye `.env`, dependencias y compilaciones.
5. Crear el commit y enlazar el repositorio vacío de GitHub:

   ```powershell
   git commit -m "Add AulaLink administration demo"
   git remote add origin https://github.com/USUARIO/aulalink.git
   git push -u origin main
   ```

   Reemplazar `USUARIO` por el usuario u organización de GitHub.

> Si `git init` informa que ya existe un repositorio local en esta carpeta, no lo reinicialices: revisa `git status`, `git remote -v` y enlaza el remoto correcto. No borres `.git` para resolverlo.

## Desplegar el panel en Vercel

1. Iniciar sesión en Vercel y elegir **Add New → Project**.
2. Importar el repositorio `aulalink` de GitHub.
3. En **Root Directory**, elegir `web` y confirmar.
4. Seleccionar el framework **Next.js**. Dejar los comandos predeterminados que detecta Vercel (`npm run build`); no cambiar el directorio raíz a la carpeta de la API.
5. No hace falta configurar variables de entorno para esta demo. No añadir secretos como `DATABASE_URL`, claves de cifrado, JWT, S3 o n8n a Vercel para este frontend.
6. Elegir **Deploy**. Al finalizar, abrir el dominio `.vercel.app` que muestra Vercel.
7. Los siguientes cambios en la rama conectada de GitHub crearán nuevos despliegues automáticamente.

Este despliegue publica únicamente la interfaz de muestra. La API y PostgreSQL deben alojarse por separado; antes de conectar el panel habrá que implementar autenticación real, permisos y endpoints para la administración. No exponer la API ni almacenar información de menores en la demo pública.
