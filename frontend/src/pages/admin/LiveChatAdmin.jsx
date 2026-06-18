/**
 * Admin Live Chat Management Page
 * Features:
 * - Real-time chat sessions list
 * - Reply to customers
 * - View AI conversations
 * - Chat settings management
 */
import React, { useState, useEffect, useRef, useCallback } from 'react';
import { 
  MessageCircle, 
  Users, 
  Bot, 
  Send, 
  Settings, 
  Clock, 
  CheckCircle,
  User,
  Search,
  Filter,
  RefreshCw,
  Loader2,
  AlertCircle,
  X,
  ChevronRight,
  MessageSquare,
  Headphones,
  Archive,
  Tag,
  Save,
  Mail,
  MapPin
} from 'lucide-react';
import { Button } from '../../components/ui/button';
import { Input } from '../../components/ui/input';
import { Label } from '../../components/ui/label';
import { Textarea } from '../../components/ui/textarea';
import { Switch } from '../../components/ui/switch';
import { Badge } from '../../components/ui/badge';
import { Card, CardContent, CardHeader, CardTitle } from '../../components/ui/card';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '../../components/ui/tabs';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from '../../components/ui/dialog';
import { toast } from 'sonner';
import { cn } from '../../lib/utils';

const API_URL = process.env.REACT_APP_BACKEND_URL || '';

export default function LiveChatAdmin() {
  const [sessions, setSessions] = useState([]);
  const [selectedSession, setSelectedSession] = useState(null);
  const [messages, setMessages] = useState([]);
  const [stats, setStats] = useState({});
  const [settings, setSettings] = useState(null);
  const [loading, setLoading] = useState(true);
  const [messagesLoading, setMessagesLoading] = useState(false);
  const [replyMessage, setReplyMessage] = useState('');
  const [sendingReply, setSendingReply] = useState(false);
  const [statusFilter, setStatusFilter] = useState('open');
  const [searchTerm, setSearchTerm] = useState('');
  const [showSettings, setShowSettings] = useState(false);
  const [settingsSaving, setSettingsSaving] = useState(false);
  
  const messagesEndRef = useRef(null);
  const wsRef = useRef(null);
  const notificationAudioRef = useRef(null);
  
  // Request browser notification permission
  useEffect(() => {
    if ('Notification' in window && Notification.permission === 'default') {
      Notification.requestPermission();
    }
  }, []);

  // Play notification sound
  const playNotificationSound = () => {
    try {
      if (!notificationAudioRef.current) {
        notificationAudioRef.current = new Audio('data:audio/wav;base64,UklGRnoGAABXQVZFZm10IBAAAAABAAEAQB8AAEAfAAABAAgAZGF0YQoGAACBhYqFbF1fdJivrJBhNjVgodDbsGczIjqNwdnesV4wHjOAxO/kqVouGiuBxfHnq1kqFSd8w/Llp1koFCh7wvPnplsoFSl9w/ToplkpFit/xfXpp1orGC2CyPjsqlwuHTCGy/vur14xIDSK0P/xsmIzITeO1ALztmU2JDqR2ATztmY3JjuT2gX0t2c4JzyV3Af1uGg5KD2W3Qj1uGk6KT+X3wn2umk7Kj+Z4Ar3u2o8K0Ca4gv4vGs+LUGY5Q35vW0/LkOb5w76vm5AL0Sc6BD7v3BCMUWe6hH8wHFDMkag7BL9wnJEMkah7RP9wnNFM0ei7hT+w3RGNEij7xX/xHVHNUmk8Bb/xXZINkql8Rf/xndJNkul8hj/x3hKN0ym8xn/yHlLOEyn9Br/yXpMOE2o9Rv/yntNOU6p9hz/y3xOOk+q9x3/zH1PO1Cr+B7/zX5QPFGr+R//zn9RPVKs+iD/z4BSPVK');
      }
      notificationAudioRef.current.volume = 0.5;
      notificationAudioRef.current.play().catch(() => {});
    } catch (e) {}
  };

  // Send browser notification
  const sendBrowserNotification = (title, body) => {
    if ('Notification' in window && Notification.permission === 'granted') {
      try {
        const n = new Notification(title, {
          body,
          icon: '/favicon.ico',
          tag: 'chat-notification',
          requireInteraction: true
        });
        n.onclick = () => {
          window.focus();
          n.close();
        };
      } catch (e) {}
    }
  };

  // Get auth token
  const getToken = () => localStorage.getItem('token');

  // Scroll to bottom of messages
  const scrollToBottom = () => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  };

  useEffect(() => {
    scrollToBottom();
  }, [messages]);

  // Fetch sessions
  const fetchSessions = useCallback(async () => {
    try {
      const response = await fetch(
        `${API_URL}/api/live-chat/sessions${statusFilter ? `?status=${statusFilter}` : ''}`,
        {
          headers: { Authorization: `Bearer ${getToken()}` }
        }
      );
      if (response.ok) {
        const data = await response.json();
        setSessions(data.sessions || []);
      }
    } catch (error) {
      console.error('Error fetching sessions:', error);
    }
  }, [statusFilter]);

  // Fetch stats
  const fetchStats = async () => {
    try {
      const response = await fetch(`${API_URL}/api/live-chat/stats`, {
        headers: { Authorization: `Bearer ${getToken()}` }
      });
      if (response.ok) {
        const data = await response.json();
        setStats(data);
      }
    } catch (error) {
      console.error('Error fetching stats:', error);
    }
  };

  // Fetch settings
  const fetchSettings = async () => {
    try {
      const response = await fetch(`${API_URL}/api/live-chat/settings`, {
        headers: { Authorization: `Bearer ${getToken()}` }
      });
      if (response.ok) {
        const data = await response.json();
        setSettings(data);
      }
    } catch (error) {
      console.error('Error fetching settings:', error);
    }
  };

  // Initial load
  useEffect(() => {
    const loadData = async () => {
      setLoading(true);
      await Promise.all([fetchSessions(), fetchStats(), fetchSettings()]);
      setLoading(false);
    };
    loadData();

    // Set up polling for sessions
    const interval = setInterval(fetchSessions, 10000);
    return () => clearInterval(interval);
  }, [fetchSessions]);

  // Connect WebSocket for real-time updates
  useEffect(() => {
    const token = getToken();
    if (!token) return;

    const wsUrl = `${API_URL.replace('https://', 'wss://').replace('http://', 'ws://')}/api/live-chat/ws/admin`;
    
    try {
      wsRef.current = new WebSocket(wsUrl);
      
      wsRef.current.onopen = () => {
        console.debug('[Admin Chat] WebSocket connected');
      };
      
      wsRef.current.onmessage = (event) => {
        try {
          const data = JSON.parse(event.data);
          
          if (data.type === 'new_session') {
            setSessions(prev => [data.session, ...prev]);
            toast.info('New chat session started', { duration: 10000 });
            playNotificationSound();
            sendBrowserNotification('New Chat', `New visitor wants to chat${data.session?.visitor_name ? ': ' + data.session.visitor_name : ''}`);
          } else if (data.type === 'new_message' || data.type === 'ai_response') {
            // Update session in list
            setSessions(prev => prev.map(s => 
              s.session_id === data.session_id 
                ? { ...s, unread_count: (s.unread_count || 0) + 1, last_activity: new Date().toISOString() }
                : s
            ));
            
            // Add message if viewing this session
            if (selectedSession?.session_id === data.session_id) {
              setMessages(prev => [...prev, data.message]);
            }

            // Notify for visitor messages only
            if (data.message?.sender === 'visitor') {
              const visitorName = data.message.sender_name || 'Visitor';
              toast.info(`${visitorName}: ${data.message.message?.substring(0, 60)}...`, { duration: 8000 });
              playNotificationSound();
              sendBrowserNotification(`Message from ${visitorName}`, data.message.message?.substring(0, 100));
            }
          } else if (data.type === 'offline_message') {
            toast.warning(`Visitor left contact details: ${data.email}`, { duration: 15000 });
            playNotificationSound();
            sendBrowserNotification('Offline Message', `${data.name || 'Visitor'} left their details: ${data.email}`);
            fetchSessions();
          } else if (data.type === 'visitor_typing') {
            // Could show typing indicator
          }
        } catch (e) {
          console.debug('[Admin Chat] Message parse error:', e);
        }
      };
      
      wsRef.current.onclose = () => {
        console.debug('[Admin Chat] WebSocket disconnected');
      };
    } catch (error) {
      console.debug('[Admin Chat] WebSocket connection error:', error);
    }

    return () => {
      if (wsRef.current) {
        wsRef.current.close();
      }
    };
  }, [selectedSession]);

  // Select a session
  const selectSession = async (session) => {
    setSelectedSession(session);
    setMessagesLoading(true);
    setReplyMessage('');
    
    try {
      const response = await fetch(`${API_URL}/api/live-chat/sessions/${session.session_id}`, {
        headers: { Authorization: `Bearer ${getToken()}` }
      });
      if (response.ok) {
        const data = await response.json();
        setMessages(data.messages || []);
        
        // Update unread count in list
        setSessions(prev => prev.map(s => 
          s.session_id === session.session_id ? { ...s, unread_count: 0 } : s
        ));
      }
    } catch (error) {
      console.error('Error fetching messages:', error);
      toast.error('Failed to load messages');
    } finally {
      setMessagesLoading(false);
    }
  };

  // Send reply
  const sendReply = async (e) => {
    e?.preventDefault();
    if (!replyMessage.trim() || !selectedSession) return;
    
    setSendingReply(true);
    const message = replyMessage.trim();
    setReplyMessage('');
    
    try {
      // Add optimistic message
      const tempMsg = {
        id: `temp-${Date.now()}`,
        sender: 'admin',
        sender_name: 'You',
        message: message,
        timestamp: new Date().toISOString()
      };
      setMessages(prev => [...prev, tempMsg]);
      
      const response = await fetch(`${API_URL}/api/live-chat/reply`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${getToken()}`
        },
        body: JSON.stringify({
          session_id: selectedSession.session_id,
          message: message
        })
      });
      
      if (response.ok) {
        const data = await response.json();
        setMessages(prev => prev.map(m => 
          m.id === tempMsg.id ? data.message : m
        ));
        toast.success('Reply sent');
      } else {
        setMessages(prev => prev.filter(m => m.id !== tempMsg.id));
        toast.error('Failed to send reply');
      }
    } catch (error) {
      console.error('Error sending reply:', error);
      toast.error('Failed to send reply');
    } finally {
      setSendingReply(false);
    }
  };

  // 18 Jun 2026 — Force-email the most recent admin reply to the visitor.
  // Useful for "missed chats" where the customer closed the tab before
  // they could see the WebSocket reply. The backend respects visitor_email
  // presence and bypasses the 60s rate-limit for this manual action.
  const [emailingReply, setEmailingReply] = useState(false);
  const emailLastReply = async () => {
    if (!selectedSession?.session_id) return;
    if (!selectedSession.visitor_email) {
      toast.error("This visitor never left an email — nothing to send to.");
      return;
    }
    setEmailingReply(true);
    try {
      const response = await fetch(
        `${API_URL}/api/live-chat/sessions/${selectedSession.session_id}/email-last-reply`,
        {
          method: 'POST',
          headers: { Authorization: `Bearer ${getToken()}` },
        }
      );
      const data = await response.json();
      if (response.ok && data.success) {
        toast.success(`Reply emailed to ${data.visitor_email}`);
      } else {
        toast.error(data.detail || data.detail?.[0]?.msg || 'Could not email the reply');
      }
    } catch (error) {
      console.error('Email-last-reply failed:', error);
      toast.error('Could not email the reply');
    } finally {
      setEmailingReply(false);
    }
  };

  // Update session status
  const updateSessionStatus = async (status) => {
    if (!selectedSession) return;
    
    try {
      const response = await fetch(`${API_URL}/api/live-chat/sessions/${selectedSession.session_id}`, {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${getToken()}`
        },
        body: JSON.stringify({ status })
      });
      
      if (response.ok) {
        setSelectedSession(prev => ({ ...prev, status }));
        setSessions(prev => prev.map(s => 
          s.session_id === selectedSession.session_id ? { ...s, status } : s
        ));
        toast.success(`Chat marked as ${status}`);
      }
    } catch (error) {
      toast.error('Failed to update status');
    }
  };

  // Save settings
  const saveSettings = async () => {
    setSettingsSaving(true);
    try {
      const response = await fetch(`${API_URL}/api/live-chat/settings`, {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${getToken()}`
        },
        body: JSON.stringify(settings)
      });
      
      if (response.ok) {
        toast.success('Settings saved');
        setShowSettings(false);
      } else {
        toast.error('Failed to save settings');
      }
    } catch (error) {
      toast.error('Failed to save settings');
    } finally {
      setSettingsSaving(false);
    }
  };

  // Format timestamp
  const formatTime = (timestamp) => {
    if (!timestamp) return '';
    const date = new Date(timestamp);
    const now = new Date();
    const diffMs = now - date;
    const diffMins = Math.floor(diffMs / 60000);
    const diffHours = Math.floor(diffMs / 3600000);
    const diffDays = Math.floor(diffMs / 86400000);
    
    if (diffMins < 1) return 'Just now';
    if (diffMins < 60) return `${diffMins}m ago`;
    if (diffHours < 24) return `${diffHours}h ago`;
    if (diffDays < 7) return `${diffDays}d ago`;
    return date.toLocaleDateString();
  };

  // Get sender icon
  const getSenderIcon = (sender) => {
    switch (sender) {
      case 'visitor':
        return <User className="w-4 h-4" />;
      case 'ai':
        return <Bot className="w-4 h-4" />;
      case 'admin':
        return <Headphones className="w-4 h-4" />;
      default:
        return <MessageCircle className="w-4 h-4" />;
    }
  };

  // Filter sessions
  const filteredSessions = sessions.filter(s => {
    if (searchTerm) {
      const search = searchTerm.toLowerCase();
      return (
        s.visitor_name?.toLowerCase().includes(search) ||
        s.visitor_email?.toLowerCase().includes(search) ||
        s.session_id.includes(search)
      );
    }
    return true;
  });

  if (loading) {
    return (
      <div className="flex items-center justify-center h-96">
        <Loader2 className="w-8 h-8 animate-spin text-gray-400" />
      </div>
    );
  }

  return (
    <div className="p-6 space-y-6" data-testid="live-chat-admin">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">Live Chat</h1>
          <p className="text-sm text-gray-500">Manage customer conversations</p>
        </div>
        <div className="flex items-center gap-3">
          <Button variant="outline" onClick={fetchSessions}>
            <RefreshCw className="w-4 h-4 mr-2" />
            Refresh
          </Button>
          <Button variant="outline" onClick={() => setShowSettings(true)}>
            <Settings className="w-4 h-4 mr-2" />
            Settings
          </Button>
        </div>
      </div>

      {/* Stats Cards */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        <Card>
          <CardContent className="pt-6">
            <div className="flex items-center gap-4">
              <div className="p-3 bg-blue-100 rounded-lg">
                <MessageSquare className="w-6 h-6 text-blue-600" />
              </div>
              <div>
                <p className="text-2xl font-bold">{stats.total_sessions || 0}</p>
                <p className="text-sm text-gray-500">Total Sessions</p>
              </div>
            </div>
          </CardContent>
        </Card>
        
        <Card>
          <CardContent className="pt-6">
            <div className="flex items-center gap-4">
              <div className="p-3 bg-green-100 rounded-lg">
                <Users className="w-6 h-6 text-green-600" />
              </div>
              <div>
                <p className="text-2xl font-bold">{stats.open_sessions || 0}</p>
                <p className="text-sm text-gray-500">Open Chats</p>
              </div>
            </div>
          </CardContent>
        </Card>
        
        <Card>
          <CardContent className="pt-6">
            <div className="flex items-center gap-4">
              <div className="p-3 bg-purple-100 rounded-lg">
                <Bot className="w-6 h-6 text-purple-600" />
              </div>
              <div>
                <p className="text-2xl font-bold">{stats.ai_messages || 0}</p>
                <p className="text-sm text-gray-500">AI Responses</p>
              </div>
            </div>
          </CardContent>
        </Card>
        
        <Card>
          <CardContent className="pt-6">
            <div className="flex items-center gap-4">
              <div className="p-3 bg-amber-100 rounded-lg">
                <Clock className="w-6 h-6 text-amber-600" />
              </div>
              <div>
                <p className="text-2xl font-bold">{stats.today_sessions || 0}</p>
                <p className="text-sm text-gray-500">Today's Chats</p>
              </div>
            </div>
          </CardContent>
        </Card>
      </div>

      {/* Main Chat Interface */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6 h-[600px]">
        {/* Sessions List */}
        <Card className="lg:col-span-1 flex flex-col">
          <CardHeader className="pb-3">
            <div className="flex items-center justify-between">
              <CardTitle className="text-lg">Conversations</CardTitle>
              <select 
                value={statusFilter}
                onChange={(e) => setStatusFilter(e.target.value)}
                className="text-sm border rounded-md px-2 py-1"
              >
                <option value="">All</option>
                <option value="open">Open</option>
                <option value="resolved">Resolved</option>
                <option value="escalated">Escalated</option>
              </select>
            </div>
            <div className="relative mt-2">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400" />
              <Input
                placeholder="Search..."
                value={searchTerm}
                onChange={(e) => setSearchTerm(e.target.value)}
                className="pl-9"
              />
            </div>
          </CardHeader>
          <CardContent className="flex-1 overflow-y-auto p-0">
            {filteredSessions.length === 0 ? (
              <div className="flex flex-col items-center justify-center h-full text-gray-500 p-4">
                <MessageCircle className="w-12 h-12 mb-2 opacity-30" />
                <p>No conversations</p>
              </div>
            ) : (
              <div className="divide-y">
                {filteredSessions.map((session) => (
                  <button
                    key={session.session_id}
                    onClick={() => selectSession(session)}
                    className={cn(
                      "w-full p-4 text-left hover:bg-gray-50 transition",
                      selectedSession?.session_id === session.session_id && "bg-blue-50 border-l-4 border-blue-500"
                    )}
                  >
                    <div className="flex items-start justify-between">
                      <div className="flex items-center gap-3">
                        <div className={cn(
                          "w-10 h-10 rounded-full flex items-center justify-center",
                          session.status === 'open' ? 'bg-green-100' : 
                          session.status === 'escalated' ? 'bg-amber-100' : 'bg-gray-100'
                        )}>
                          <User className={cn(
                            "w-5 h-5",
                            session.status === 'open' ? 'text-green-600' : 
                            session.status === 'escalated' ? 'text-amber-600' : 'text-gray-400'
                          )} />
                        </div>
                        <div>
                          <p className="font-medium text-gray-900">
                            {session.visitor_name || 'Anonymous Visitor'}
                          </p>
                          <p className="text-xs text-gray-500">
                            {session.location?.city && session.location?.country 
                              ? `${session.location.city}, ${session.location.country}` 
                              : `${session.message_count || 0} messages`
                            }
                          </p>
                        </div>
                      </div>
                      <div className="text-right">
                        <p className="text-xs text-gray-500">
                          {formatTime(session.last_activity)}
                        </p>
                        {session.unread_count > 0 && (
                          <Badge variant="destructive" className="mt-1">
                            {session.unread_count}
                          </Badge>
                        )}
                      </div>
                    </div>
                  </button>
                ))}
              </div>
            )}
          </CardContent>
        </Card>

        {/* Chat Window */}
        <Card className="lg:col-span-2 flex flex-col">
          {selectedSession ? (
            <>
              {/* Chat Header */}
              <CardHeader className="pb-3 border-b">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-3">
                    <div className="w-10 h-10 rounded-full bg-gray-100 flex items-center justify-center">
                      <User className="w-5 h-5 text-gray-600" />
                    </div>
                    <div>
                      <p className="font-medium">{selectedSession.visitor_name || 'Anonymous Visitor'}</p>
                      <p className="text-sm text-gray-500">
                        {selectedSession.visitor_email || selectedSession.session_id.substring(0, 8)}
                      </p>
                      {selectedSession.location?.city && selectedSession.location?.country && (
                        <p className="text-xs text-gray-400 flex items-center gap-1">
                          <MapPin className="w-3 h-3" />
                          {selectedSession.location.city}, {selectedSession.location.country}
                        </p>
                      )}
                    </div>
                  </div>
                  <div className="flex items-center gap-2">
                    <Badge variant={
                      selectedSession.status === 'open' ? 'default' :
                      selectedSession.status === 'escalated' ? 'warning' : 'secondary'
                    }>
                      {selectedSession.status}
                    </Badge>
                    {selectedSession.visitor_email && (
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={emailLastReply}
                        disabled={emailingReply}
                        title={`Email the last admin reply to ${selectedSession.visitor_email}`}
                        data-testid="email-last-reply-btn"
                      >
                        {emailingReply ? (
                          <Loader2 className="w-4 h-4 mr-1 animate-spin" />
                        ) : (
                          <Mail className="w-4 h-4 mr-1" />
                        )}
                        Email reply
                      </Button>
                    )}
                    {selectedSession.status === 'open' && (
                      <Button 
                        variant="outline" 
                        size="sm"
                        onClick={() => updateSessionStatus('resolved')}
                      >
                        <CheckCircle className="w-4 h-4 mr-1" />
                        Resolve
                      </Button>
                    )}
                    {selectedSession.status === 'resolved' && (
                      <Button 
                        variant="outline" 
                        size="sm"
                        onClick={() => updateSessionStatus('open')}
                      >
                        Reopen
                      </Button>
                    )}
                  </div>
                </div>
              </CardHeader>

              {/* Messages */}
              <CardContent className="flex-1 overflow-y-auto p-4 space-y-4 bg-gray-50">
                {messagesLoading ? (
                  <div className="flex items-center justify-center h-full">
                    <Loader2 className="w-6 h-6 animate-spin text-gray-400" />
                  </div>
                ) : (
                  <>
                    {messages.map((msg, idx) => (
                      <div
                        key={msg.id || idx}
                        className={cn(
                          "flex gap-2",
                          msg.sender === 'admin' ? 'justify-end' : 'justify-start'
                        )}
                      >
                        {msg.sender !== 'admin' && (
                          <div className={cn(
                            "w-8 h-8 rounded-full flex items-center justify-center flex-shrink-0",
                            msg.sender === 'visitor' ? 'bg-blue-100 text-blue-600' :
                            msg.sender === 'ai' ? 'bg-purple-100 text-purple-600' : 
                            'bg-gray-100 text-gray-600'
                          )}>
                            {getSenderIcon(msg.sender)}
                          </div>
                        )}
                        <div className={cn(
                          "max-w-[75%] rounded-2xl px-4 py-2",
                          msg.sender === 'admin' 
                            ? 'bg-blue-600 text-white rounded-br-md' 
                            : msg.sender === 'ai'
                            ? 'bg-purple-50 border border-purple-100 rounded-bl-md'
                            : 'bg-white shadow-sm rounded-bl-md'
                        )}>
                          {msg.sender !== 'admin' && (
                            <p className={cn(
                              "text-xs font-medium mb-1",
                              msg.sender === 'ai' ? 'text-purple-600' : 'text-gray-500'
                            )}>
                              {msg.sender_name || (msg.sender === 'ai' ? 'AI Assistant' : 'Visitor')}
                            </p>
                          )}
                          <p className="text-sm">{msg.message}</p>
                          <p className={cn(
                            "text-xs mt-1",
                            msg.sender === 'admin' ? 'text-white/60' : 'text-gray-400'
                          )}>
                            {formatTime(msg.timestamp)}
                          </p>
                        </div>
                        {msg.sender === 'admin' && (
                          <div className="w-8 h-8 rounded-full bg-blue-100 flex items-center justify-center flex-shrink-0">
                            <Headphones className="w-4 h-4 text-blue-600" />
                          </div>
                        )}
                      </div>
                    ))}
                    <div ref={messagesEndRef} />
                  </>
                )}
              </CardContent>

              {/* Reply Input */}
              <div className="p-4 border-t bg-white">
                <form onSubmit={sendReply} className="flex gap-2">
                  <Input
                    value={replyMessage}
                    onChange={(e) => setReplyMessage(e.target.value)}
                    placeholder="Type your reply..."
                    className="flex-1"
                    disabled={sendingReply || selectedSession.status === 'resolved'}
                  />
                  <Button 
                    type="submit" 
                    disabled={!replyMessage.trim() || sendingReply || selectedSession.status === 'resolved'}
                  >
                    {sendingReply ? (
                      <Loader2 className="w-4 h-4 animate-spin" />
                    ) : (
                      <Send className="w-4 h-4" />
                    )}
                  </Button>
                </form>
              </div>
            </>
          ) : (
            <div className="flex flex-col items-center justify-center h-full text-gray-500">
              <MessageCircle className="w-16 h-16 mb-4 opacity-30" />
              <p className="text-lg font-medium">Select a conversation</p>
              <p className="text-sm">Choose a chat from the list to view messages</p>
            </div>
          )}
        </Card>
      </div>

      {/* Settings Dialog */}
      <Dialog open={showSettings} onOpenChange={setShowSettings}>
        <DialogContent className="max-w-lg max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>Chat Widget Settings</DialogTitle>
          </DialogHeader>
          
          {settings && (
            <div className="space-y-6">
              <div className="flex items-center justify-between">
                <div>
                  <Label>Enable Chat Widget</Label>
                  <p className="text-sm text-gray-500">Show chat widget on website</p>
                </div>
                <Switch
                  checked={settings.enabled}
                  onCheckedChange={(checked) => setSettings({ ...settings, enabled: checked })}
                />
              </div>
              
              <div className="flex items-center justify-between">
                <div>
                  <Label>AI Responses</Label>
                  <p className="text-sm text-gray-500">Use AI for initial responses</p>
                </div>
                <Switch
                  checked={settings.ai_enabled}
                  onCheckedChange={(checked) => setSettings({ ...settings, ai_enabled: checked })}
                />
              </div>
              
              <div>
                <Label>Welcome Message</Label>
                <Textarea
                  value={settings.welcome_message}
                  onChange={(e) => setSettings({ ...settings, welcome_message: e.target.value })}
                  className="mt-1"
                  rows={2}
                />
              </div>
              
              <div>
                <Label>Offline Message</Label>
                <Textarea
                  value={settings.offline_message}
                  onChange={(e) => setSettings({ ...settings, offline_message: e.target.value })}
                  className="mt-1"
                  rows={2}
                />
              </div>

              <div>
                <Label>Connecting Message</Label>
                <p className="text-sm text-gray-500 mb-1">Shown after visitor sends their first message</p>
                <Textarea
                  value={settings.connecting_message || 'Please wait while we connect you to our customer service team member.'}
                  onChange={(e) => setSettings({ ...settings, connecting_message: e.target.value })}
                  className="mt-1"
                  rows={2}
                />
              </div>

              {/* Online Hours & Timeout */}
              <div className="pt-4 border-t">
                <h3 className="font-medium mb-4 flex items-center gap-2">
                  <Clock className="w-4 h-4" />
                  Online Hours & Timeout
                </h3>
                <div className="grid grid-cols-2 gap-4">
                  <div>
                    <Label>Online From</Label>
                    <Input
                      type="time"
                      value={settings.online_hours_start || '08:00'}
                      onChange={(e) => setSettings({ ...settings, online_hours_start: e.target.value })}
                      className="mt-1"
                    />
                  </div>
                  <div>
                    <Label>Online Until</Label>
                    <Input
                      type="time"
                      value={settings.online_hours_end || '18:00'}
                      onChange={(e) => setSettings({ ...settings, online_hours_end: e.target.value })}
                      className="mt-1"
                    />
                  </div>
                </div>
                <div className="mt-3">
                  <Label>No Response Timeout (minutes)</Label>
                  <p className="text-sm text-gray-500 mb-1">Show contact form if no agent responds within this time</p>
                  <Input
                    type="number"
                    min={1}
                    max={30}
                    value={settings.no_response_timeout ?? 2}
                    onChange={(e) => setSettings({ ...settings, no_response_timeout: parseInt(e.target.value) || 2 })}
                    className="w-24 mt-1"
                  />
                </div>
              </div>

              {/* Browser Notifications */}
              <div className="pt-4 border-t">
                <h3 className="font-medium mb-4 flex items-center gap-2">
                  <AlertCircle className="w-4 h-4" />
                  Browser Notifications
                </h3>
                <div className="flex items-center justify-between mb-3">
                  <div>
                    <Label>Sound Alert</Label>
                    <p className="text-sm text-gray-500">Play sound on new messages</p>
                  </div>
                  <Switch
                    checked={settings.browser_notification_sound !== false}
                    onCheckedChange={(checked) => setSettings({ ...settings, browser_notification_sound: checked })}
                  />
                </div>
                <div className="bg-blue-50 rounded-lg p-3 text-sm text-blue-700">
                  <p className="font-medium mb-1">Mobile Notifications</p>
                  <p>To receive notifications on your phone, open this admin panel in your mobile browser and allow notifications when prompted. You can also add this site to your home screen for a native app-like experience.</p>
                </div>
              </div>
              
              <div>
                <Label>Theme Color</Label>
                <div className="flex items-center gap-3 mt-1">
                  <Input
                    type="color"
                    value={settings.theme_color}
                    onChange={(e) => setSettings({ ...settings, theme_color: e.target.value })}
                    className="w-16 h-10 p-1 cursor-pointer"
                  />
                  <Input
                    value={settings.theme_color}
                    onChange={(e) => setSettings({ ...settings, theme_color: e.target.value })}
                    className="flex-1"
                  />
                </div>
              </div>
              
              {/* Email Notification Settings */}
              <div className="pt-4 border-t">
                <h3 className="font-medium mb-4 flex items-center gap-2">
                  <Mail className="w-4 h-4" />
                  Email Notifications
                </h3>
                
                <div className="space-y-4">
                  <div className="flex items-center justify-between">
                    <div>
                      <Label>Enable Notifications</Label>
                      <p className="text-sm text-gray-500">Email when chats go unanswered</p>
                    </div>
                    <Switch
                      checked={settings.notification_enabled ?? true}
                      onCheckedChange={(checked) => setSettings({ ...settings, notification_enabled: checked })}
                    />
                  </div>
                  
                  <div>
                    <Label>Wait Time (minutes)</Label>
                    <p className="text-sm text-gray-500 mb-1">Send alert after visitor waits this long</p>
                    <Input
                      type="number"
                      min={1}
                      max={60}
                      value={settings.notification_threshold_minutes ?? 5}
                      onChange={(e) => setSettings({ ...settings, notification_threshold_minutes: parseInt(e.target.value) || 5 })}
                      className="w-24"
                    />
                  </div>
                  
                  <div>
                    <Label>Notification Emails</Label>
                    <p className="text-sm text-gray-500 mb-1">Comma-separated email addresses</p>
                    <Input
                      value={(settings.notification_emails || []).join(', ')}
                      onChange={(e) => setSettings({ 
                        ...settings, 
                        notification_emails: e.target.value.split(',').map(email => email.trim()).filter(Boolean)
                      })}
                      placeholder="email1@example.com, email2@example.com"
                    />
                  </div>
                </div>
              </div>
              
              <div className="flex justify-end gap-2 pt-4 border-t">
                <Button variant="outline" onClick={() => setShowSettings(false)}>
                  Cancel
                </Button>
                <Button onClick={saveSettings} disabled={settingsSaving}>
                  {settingsSaving ? (
                    <Loader2 className="w-4 h-4 animate-spin mr-2" />
                  ) : (
                    <Save className="w-4 h-4 mr-2" />
                  )}
                  Save Settings
                </Button>
              </div>
            </div>
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}
