import { Upload, FileText } from "lucide-react";
import { useState } from "react";
import { Button } from "@/components/ui/button";

interface FileUploadZoneProps {
  onFileSelect: (file: File) => void;
}

export default function FileUploadZone({ onFileSelect }: FileUploadZoneProps) {
  const [isDragging, setIsDragging] = useState(false);

  const handleDragOver = (e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(true);
  };

  const handleDragLeave = () => {
    setIsDragging(false);
  };

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(false);
    const file = e.dataTransfer.files[0];
    if (file && (file.name.endsWith('.csv') || file.name.endsWith('.pdf'))) {
      onFileSelect(file);
    }
  };

  const handleFileInput = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) {
      onFileSelect(file);
    }
  };

  return (
    <div
      data-testid="file-upload-zone"
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
      className={`
        min-h-64 rounded-lg border-2 border-dashed 
        flex flex-col items-center justify-center p-12
        transition-colors duration-200
        ${isDragging 
          ? 'border-primary bg-primary/5' 
          : 'border-border hover:border-primary/50'
        }
      `}
    >
      <div className="flex flex-col items-center gap-4 text-center">
        <div className="rounded-full bg-primary/10 p-6">
          <Upload className="h-10 w-10 text-primary" />
        </div>
        
        <div className="space-y-2">
          <h3 className="text-lg font-semibold">Upload your P&L Statement</h3>
          <p className="text-sm text-muted-foreground max-w-sm">
            Drop your CSV or PDF file here or click to browse
          </p>
        </div>

        <input
          type="file"
          id="file-input"
          accept=".csv,.pdf"
          onChange={handleFileInput}
          className="hidden"
          data-testid="input-file"
        />
        
        <Button 
          variant="outline" 
          onClick={() => document.getElementById('file-input')?.click()}
          data-testid="button-browse"
        >
          <FileText className="h-4 w-4 mr-2" />
          Browse Files
        </Button>

        <div className="text-xs text-muted-foreground space-y-1">
          <p>Supported formats: CSV (QuickBooks export) or PDF</p>
          <p>Maximum file size: 20MB</p>
        </div>
      </div>
    </div>
  );
}
