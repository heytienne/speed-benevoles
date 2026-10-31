# Publie sur GitHub les changements du projet (lancé par Claude Code à la fin de chaque tour).
# Le fichier .gitignore décide de ce qui reste uniquement sur le disque.
$git = 'C:\Program Files\Git\cmd\git.exe'
Set-Location (Split-Path -Parent $PSScriptRoot)

function Notify($message) {
  @{ systemMessage = $message } | ConvertTo-Json -Compress
}

if (& $git status --porcelain) {
  & $git add -A *> $null
  & $git commit -q -m ("Mise a jour " + (Get-Date -Format 'yyyy-MM-dd HH:mm')) *> $null
  if ($LASTEXITCODE -ne 0) { Notify 'Publication GitHub : le commit a echoue.'; exit 0 }
}

# Couvre aussi un commit dont l'envoi précédent a échoué (réseau coupé par exemple).
if (& $git log origin/main..HEAD --oneline) {
  & $git push -q origin main *> $null
  if ($LASTEXITCODE -eq 0) { Notify 'Publie sur GitHub.' }
  else { Notify "Publication GitHub : l'envoi a echoue, il sera retente au prochain tour." }
}
exit 0
