@echo off
chcp 65001 >nul
rem 6단계 웹 화면 한 번에 실행: Python 확인 -> 가상환경 -> 패키지 설치 -> 서버 실행
rem 사용: 더블클릭, 또는 run_web.bat --no-mic
cd /d "%~dp0"

where py >nul 2>nul
if errorlevel 1 (
  echo [1/3] Python이 없어 설치합니다. 설치 창이 뜨면 허용해 주세요.
  winget install -e --id Python.Python.3.12 --accept-package-agreements --accept-source-agreements
  echo.
  echo Python 설치가 끝났습니다. 이 창을 닫고 run_web.bat 을 다시 실행하세요.
  pause
  exit /b
)

if not exist venv\Scripts\python.exe (
  echo [1/3] 가상환경을 만듭니다.
  py -3.12 -m venv venv 2>nul || py -3 -m venv venv || goto :fail
)

echo [2/3] 패키지를 확인합니다. 처음에는 몇 분 걸립니다.
venv\Scripts\python -m pip install -q --disable-pip-version-check -r requirements.txt || goto :fail

echo [3/3] 서버를 켭니다. 브라우저가 자동으로 열립니다. 끝내려면 이 창에서 Ctrl+C
venv\Scripts\python web_server.py %*
pause
exit /b

:fail
echo.
echo 설치 중 오류가 났습니다. 이 창의 내용을 캡처해서 보내 주세요.
pause
