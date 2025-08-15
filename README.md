[![VS Marketplace Badge](https://img.shields.io/visual-studio-marketplace/v/timheuer.vscode-awesome-copilot?label=VS%20Code%20Marketplace&color=brightgreen&logo=visualstudiocode)](https://marketplace.visualstudio.com/items?itemName=TimHeuer.vscode-awesome-copilot)

# Awesome GitHub Copilot Browser

A VS Code extension that allows you to browse, preview, and download GitHub Copilot customizations from the [awesome-copilot repository](https://github.com/github/awesome-copilot).

## Features

- **🔍 Browse**: Explore chat modes, instructions, and prompts in a convenient tree view
- **📖 Preview**: View file content before downloading
- **⬇️ Download**: Save files to appropriate `.github/` folders in your workspace
- **🔃 Refresh**: Update repository data with manual refresh
- **💾 Caching**: Smart caching for better performance

## How to Use

1. **Open the Extension**: Look for "Awesome Copilot" in the Explorer panel
2. **Browse Categories**: Expand Chat Modes, Instructions, or Prompts sections
3. **Preview Content**: Click the preview icon on any file to see its content
4. **Download Files**: Click the download icon to save files to your workspace
5. **Refresh Data**: Click the refresh icon in the view title to update repository data

## Folder Structure

Downloaded files are organized in your workspace as follows:

- **Chat Modes** → `.github/chatmodes/`
- **Instructions** → `.github/instructions/`  
- **Prompts** → `.github/prompts/`

These folders will be created automatically if they don't exist.

## Requirements

- VS Code version 1.103.0 or higher
- Internet connection to fetch repository data
- A workspace folder open in VS Code (for downloads)

## Extension Commands

- `Refresh`: Update repository data from GitHub
- `Download`: Save a file to your workspace
- `Preview`: View file content in VS Code

---

## Development

This extension was built with:

- TypeScript
- VS Code Extension API
- Axios for HTTP requests
- ESBuild for bundling

### Building

```bash
npm install
npm run compile
```

### Testing  

```bash
npm run test
```

**Enjoy browsing and using awesome GitHub Copilot customizations!**
