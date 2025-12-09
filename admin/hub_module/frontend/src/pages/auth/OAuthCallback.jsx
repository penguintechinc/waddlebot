import { useEffect } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { useAuth } from '../../contexts/AuthContext';

function OAuthCallback() {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const { handleOAuthCallback } = useAuth();

  useEffect(() => {
    const token = searchParams.get('token');
    const error = searchParams.get('error');

    if (error) {
      navigate(`/login?error=${error}`);
      return;
    }

    if (token) {
      handleOAuthCallback(token).then(() => {
        navigate('/dashboard');
      });
    } else {
      navigate('/login?error=missing_token');
    }
  }, [searchParams, handleOAuthCallback, navigate]);

  return (
    <div className="min-h-[80vh] flex items-center justify-center">
      <div className="text-center">
        <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-primary-600 mx-auto"></div>
        <p className="mt-4 text-slate-600">Completing sign in...</p>
      </div>
    </div>
  );
}

export default OAuthCallback;
