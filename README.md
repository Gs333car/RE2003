# RE2003
A decompilation of Nascar Racing 2003 Season

This is an attempt to make nr2003 open-source
This project originated initially from https://github.com/TChapman500/OpenNR2003, an early decompilation attempt, and the base of the RE2003 project. Unfortunately, the RE2003 team posted its code on reddit posts instead of creating a github repo, and they eventually deleted their posts. Fortunately, I downloaded the 0.0.041 release before the posts went down, and, seeing that the project was not progressing, and that no other releases were submitted, I decided to share the source code.

I DON'T HAVE ANY LINKS WITH THE RE2003 TEAM, and if Iracing wants me to close the repo, I will close it

# Project Goals
Here are the following goals for this project. All pull requests must work to advance one of these goals or the request will be rejected. No pull request shall be made which attempts to fundamentally alter what the game is.

Decompile the game into readable source code, such that recompiling will produce the exact same results as the original game.
Make 64-bit versions of the game and tools.
Make the game and tools cross-platform.
Try optimizing the physcis engine using the SSE and AVX instruction sets (or CPU-specific vector instruction sets).
Remove the arbitrary lap, series, and track limits from the game.
Make the FoV setting work in widescreen aspect ratios.
Give the FoV setting a much lower minimum value.
Update the graphics API to Direct3D 11, and modern OpenGL versions.
Allow for series to use custom physics sets using INI files in addition to being able to select from one of the hardcoded physics sets.
Remove the CD check and the check to see if the game has been "properly installed".
Make the PAS exporter work with modern versions of 3DS Max.

# How to use it

Just grab the latest release, extract the zip, and launch RE2003.html with a browser, like google chrome, fiirefox or microsoft edge.
