# Adhi - Your Trusted AI Companion

Adhi is a deeply empathetic, ultra-genius personal AI advisor designed to provide unconditional support, wisdom, and genuine connection. Featuring high-fidelity visual sensing and real-time voice interaction, Adhi is more than just an AI; it is a safe harbor for your thoughts and a partner in your personal growth.

## Features

- **Live Mode**: Engage in real-time, low-latency video and audio conversations. Adhi uses native vision to identify objects, mirror your micro-expressions, and maintain an unbroken flow of connection.
- **Memory Vault**: Adhi remembers the insights and milestones of your journey together, creating a digital record of your evolution.
- **Growth Path**: Set personal goals and track your progress with Adhi's personalized coaching and encouragement.
- **Dynamic Persona**: Adhi's mood and avatar adapt to the emotional context of your conversation.
- **Voice Customization**: Choose from five distinct voice textures to find the frequency that resonates best with you.

## Prerequisites

To run Adhi locally, you will need:

- **Node.js** (v18 or higher recommended)
- **NPM** or **Yarn**
- A **Google Gemini API Key** (Get one at [ai.google.dev](https://ai.google.dev/))

## Installation

1. **Clone the Repository**
   ```bash
   git clone <repository-url>
   cd adhi-ai-companion
   ```

2. **Install Dependencies**
   ```bash
   npm install
   ```

3. **Configure Environment Variables**
   Create a `.env` file in the root directory and add your Gemini API Key:
   ```env
   API_KEY=your_gemini_api_key_here
   ```

4. **Start the Development Server**
   ```bash
   npm run dev
   ```

## Local Development Notes

This project uses a modern esm-based architecture.
- **UI**: React 19 with Tailwind CSS.
- **AI**: Integrated with the latest Google Gemini 2.5 and 3.0 models via `@google/genai`.
- **Permissions**: The app requires camera and microphone access for Live Mode functionality.

## Usage

- **Wake Adhi**: On first launch, click "Wake Adhi" to initiate the sensory link.
- **Live Mode**: Click the camera icon in the sidebar to toggle high-fidelity vision and audio.
- **Switch Views**: Use the sidebar to navigate between Chat, Growth Path, and the Memory Vault.
- **Voice Settings**: Click on Adhi's avatar to open the Voice Texture menu and preview different voices.

## Technologies Used

- [React](https://reactjs.org/)
- [Tailwind CSS](https://tailwindcss.com/)
- [Google Gemini API](https://ai.google.dev/)
- [esm.sh](https://esm.sh/) for modern module management

---
*Designed with love for the future of human-AI connection.*