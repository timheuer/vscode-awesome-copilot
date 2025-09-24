#!/bin/bash

echo "🔧 Compiling extension..."
npm run compile

if [ $? -eq 0 ]; then
    echo "✅ Compilation successful!"
    echo "🚀 Starting extension development environment..."
    
    # Try different ways to launch VS Code
    if command -v code &> /dev/null; then
        echo "Launching using 'code' command..."
        code --extensionDevelopmentPath="$(pwd)" --new-window
    elif [ -f "/Applications/Visual Studio Code.app/Contents/Resources/app/bin/code" ]; then
        echo "Launching using macOS application path..."
        "/Applications/Visual Studio Code.app/Contents/Resources/app/bin/code" --extensionDevelopmentPath="$(pwd)" --new-window
    else
        echo "❌ Unable to find VS Code command"
        echo "Please manually press F5 in VS Code to test the extension"
        echo "Or run the following command to add code to PATH:"
        echo "  Open VS Code -> Cmd+Shift+P -> Type 'shell command' -> Select 'Install code command in PATH'"
    fi
else
    echo "❌ Compilation failed, please check error messages"
fi
