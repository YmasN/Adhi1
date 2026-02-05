
import React from 'react';
import { Message } from '../types';

interface ChatMessageProps {
  message: Message;
}

const ChatMessage: React.FC<ChatMessageProps> = ({ message }) => {
  const isAdhi = message.role === 'adhi';

  // Function to render text with italicized expressions
  const renderText = (text: string) => {
    const parts = text.split(/(\*[^*]+\*)/g);
    return parts.map((part, i) => {
      if (part.startsWith('*') && part.endsWith('*')) {
        return <span key={i} className="italic text-white/60 font-light">{part}</span>;
      }
      return <span key={i}>{part}</span>;
    });
  };

  const isImage = message.fileData?.mimeType.startsWith('image/');

  return (
    <div className={`flex w-full mb-6 ${isAdhi ? 'justify-start' : 'justify-end'}`}>
      <div className={`max-w-[80%] md:max-w-[70%] p-4 rounded-2xl transition-all duration-300 ${
        isAdhi 
          ? 'bg-slate-800/50 border border-white/5 text-slate-100 rounded-bl-none' 
          : 'bg-indigo-600/30 border border-indigo-400/20 text-indigo-50 rounded-br-none shadow-lg'
      }`}>
        {message.fileData && (
          <div className="mb-3">
            {isImage ? (
              <img 
                src={`data:${message.fileData.mimeType};base64,${message.fileData.data}`} 
                alt="Uploaded attachment" 
                className="max-h-60 w-auto rounded-lg border border-white/10 shadow-sm"
              />
            ) : (
              <div className="flex items-center gap-2 p-2 bg-white/5 rounded-lg border border-white/10 text-xs">
                <svg xmlns="http://www.w3.org/2000/svg" className="h-4 w-4 opacity-50" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15.172 7l-6.586 6.586a2 2 0 102.828 2.828l6.414-6.586a4 4 0 00-5.656-5.656l-6.415 6.585a6 6 0 108.486 8.486L20.5 13" />
                </svg>
                <span className="opacity-70">Attachment ({message.fileData.mimeType})</span>
              </div>
            )}
          </div>
        )}
        <p className="text-sm md:text-base leading-relaxed whitespace-pre-wrap">
          {renderText(message.text)}
        </p>

        {isAdhi && message.sources && message.sources.length > 0 && (
          <div className="mt-4 pt-3 border-t border-white/5">
            <p className="text-[9px] uppercase tracking-widest text-white/30 font-bold mb-2">Sources Found</p>
            <div className="flex flex-wrap gap-2">
              {message.sources.map((source, idx) => (
                <a 
                  key={idx} 
                  href={source.uri} 
                  target="_blank" 
                  rel="noopener noreferrer"
                  className="px-3 py-1 bg-indigo-500/10 hover:bg-indigo-500/20 border border-indigo-400/20 rounded-full text-[10px] text-indigo-300 transition-colors flex items-center gap-1.5"
                >
                  <svg xmlns="http://www.w3.org/2000/svg" className="h-3 w-3" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14" />
                  </svg>
                  {source.title.length > 30 ? source.title.substring(0, 30) + '...' : source.title}
                </a>
              ))}
            </div>
          </div>
        )}

        <div className={`text-[10px] mt-2 opacity-30 ${isAdhi ? 'text-left' : 'text-right'}`}>
          {message.timestamp.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
        </div>
      </div>
    </div>
  );
};

export default ChatMessage;
