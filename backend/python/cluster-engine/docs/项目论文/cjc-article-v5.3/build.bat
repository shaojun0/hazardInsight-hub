@echo off
rem 完整编译：xelatex -> bibtex -> xelatex -> xelatex
setlocal
cd /d "%~dp0"
set NAME=cjc-article-v5.3

echo [1/4] xelatex ...
xelatex -interaction=nonstopmode -halt-on-error %NAME%.tex || goto :err
echo [2/4] bibtex ...
bibtex %NAME% || goto :err
echo [3/4] xelatex ...
xelatex -interaction=nonstopmode -halt-on-error %NAME%.tex || goto :err
echo [4/4] xelatex ...
xelatex -interaction=nonstopmode -halt-on-error %NAME%.tex || goto :err

if exist %NAME%.pdf (
  echo.
  echo Done: %CD%\%NAME%.pdf
) else (
  goto :err
)
exit /b 0

:err
echo.
echo Build FAILED - check %NAME%.log
exit /b 1
