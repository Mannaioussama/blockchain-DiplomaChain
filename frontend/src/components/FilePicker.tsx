type Props = {
  id: string;
  label: string;
  accept: string;
  multiple?: boolean;
  fileName?: string | null;
  onFiles: (files: FileList | null) => void;
  buttonText?: string;
};

export function FilePicker({
  id,
  label,
  accept,
  multiple = false,
  fileName,
  onFiles,
  buttonText = "Choose file",
}: Props) {
  return (
    <div className="file-picker">
      <label className="label" htmlFor={id}>
        {label}
      </label>
      <div className="file-picker-row">
        <input
          id={id}
          className="file-picker-input"
          type="file"
          accept={accept}
          multiple={multiple}
          onChange={(e) => onFiles(e.target.files)}
        />
        <label htmlFor={id} className="btn file-picker-btn">
          {buttonText}
        </label>
        <span className="file-picker-name" title={fileName ?? undefined}>
          {fileName?.trim() ? fileName : "No file selected"}
        </span>
      </div>
    </div>
  );
}
