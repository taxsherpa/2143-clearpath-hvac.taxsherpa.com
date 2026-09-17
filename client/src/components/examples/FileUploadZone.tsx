import FileUploadZone from '../FileUploadZone';

export default function FileUploadZoneExample() {
  return (
    <div className="p-8 max-w-2xl mx-auto">
      <FileUploadZone 
        onFileSelect={(file) => console.log('File selected:', file.name)} 
      />
    </div>
  );
}
